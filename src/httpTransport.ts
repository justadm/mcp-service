import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { createConnector } from "./connectors/factory.js";

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeenAt: number;
};

export async function serveHttp(config: AppConfig) {
  const cfg = config.transport;
  if (cfg.type !== "http") throw new Error("serveHttp ожидает transport.type=http");

  const host = cfg.host ?? "0.0.0.0";
  const port = cfg.port ?? 8080;
  const mcpPath = cfg.path ?? "/mcp";
  const stateful = cfg.stateful ?? true;
  const maxBodyBytes = 1_000_000;

  async function createServer() {
    const server = new McpServer({
      name: config.server.name,
      version: config.server.version,
    });
    for (const src of config.sources) {
      const c = createConnector(src);
      await c.register({ server });
    }
    return server;
  }

  // В stateful режиме SDK transport поддерживает только одну "сессию" на инстанс транспорта.
  // Поэтому для multi-client HTTP сервиса мы держим map: sessionId -> (server+transport).
  const sessions = new Map<string, Session>();
  const sessionTtlMs = 6 * 60 * 60 * 1000; // MVP: 6h, чтобы не протечь по памяти.

  function reapOldSessions(now: number) {
    for (const [sid, s] of sessions) {
      if (now - s.lastSeenAt > sessionTtlMs) {
        sessions.delete(sid);
        // best-effort
        s.transport.close().catch(() => {});
      }
    }
  }

  const reaper = setInterval(() => reapOldSessions(Date.now()), 60_000);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  (reaper as any).unref?.();

  async function createStatefulSession() {
    const server = await createServer();
    let sid: string | null = null;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sid = sessionId;
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
      // В реальности SSE-стриминг может быть хрупким за reverse-proxy.
      // Для MVP включаем JSON ответы (без SSE), чтобы снизить количество "магии" при деплое.
      enableJsonResponse: true,
    });

    transport.onerror = (err) => {
      // Важно для отладки: иначе некоторые ошибки транспорта превращаются в "500 без тела".
      // Логи пойдут в stdout/stderr контейнера.
      console.error("[mcp-service] transport error:", err);
    };

    await server.connect(transport);

    return { server, transport, getSessionId: () => sid };
  }

  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (url.pathname === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === "/ready") {
        // HTTP сервер "готов", если процесс жив. MCP-сессии создаются лениво.
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
        return;
      }

      if (url.pathname !== mcpPath) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      const now = Date.now();
      reapOldSessions(now);

      if (req.method === "POST") {
        const len = Number(req.headers["content-length"] ?? "0");
        if (Number.isFinite(len) && len > maxBodyBytes) {
          res.statusCode = 413;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "payload too large" }));
          return;
        }

        const sessionId = String(req.headers["mcp-session-id"] ?? "").trim();

        // Важно: не читаем req body сами. `@hono/node-server` конвертирует Node.js request в Web Request,
        // и если заранее вычитать stream, конвертация может падать (500).
        if (!stateful) {
          // Stateless: SDK требует новый transport на каждый запрос.
          const server = await createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          transport.onerror = (err) => console.error("[mcp-service] transport error:", err);
          await server.connect(transport);
          await transport.handleRequest(req, res);
          await transport.close().catch(() => {});
          return;
        }

        if (!sessionId) {
          // Initialize: создаем новую сессию/сервер.
          const sess = await createStatefulSession();
          await sess.transport.handleRequest(req, res);
          const sid = sess.getSessionId();
          if (sid) {
            sessions.set(sid, { server: sess.server, transport: sess.transport, createdAt: now, lastSeenAt: now });
          }
          return;
        }

        const s = sessions.get(sessionId);
        if (!s) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "session not found" }));
          return;
        }

        s.lastSeenAt = now;
        await s.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "GET") {
        if (!stateful) {
          // Stateless mode не поддерживает SSE/GET на одном transport; создаем на запрос.
          const server = await createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          transport.onerror = (err) => console.error("[mcp-service] transport error:", err);
          await server.connect(transport);
          await transport.handleRequest(req, res);
          await transport.close().catch(() => {});
          return;
        }

        const sessionId = String(req.headers["mcp-session-id"] ?? "").trim();
        if (!sessionId) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "mcp-session-id required" }));
          return;
        }
        const s = sessions.get(sessionId);
        if (!s) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "session not found" }));
          return;
        }
        s.lastSeenAt = Date.now();
        await s.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "DELETE") {
        if (!stateful) {
          res.statusCode = 405;
          res.setHeader("allow", "GET, POST");
          res.end();
          return;
        }

        const sessionId = String(req.headers["mcp-session-id"] ?? "").trim();
        if (!sessionId) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "mcp-session-id required" }));
          return;
        }
        const s = sessions.get(sessionId);
        if (!s) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "session not found" }));
          return;
        }
        s.lastSeenAt = Date.now();
        await s.transport.handleRequest(req, res);
        return;
      }

      res.statusCode = 405;
      res.setHeader("allow", "GET, POST, DELETE");
      res.end();
    } catch (e) {
      console.error("[mcp-service] http handler error:", e);
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: String(e) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, host, () => resolve());
  });
}
