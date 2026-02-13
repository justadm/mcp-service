import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";

export async function serveHttp(server: McpServer, cfg: AppConfig["transport"]) {
  const host = cfg.host ?? "0.0.0.0";
  const port = cfg.port ?? 8080;
  const mcpPath = cfg.path ?? "/mcp";
  const stateful = cfg.stateful ?? true;
  const maxBodyBytes = 1_000_000;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: stateful ? () => randomUUID() : undefined,
  });

  transport.onerror = (err) => {
    // Важно для отладки: иначе некоторые ошибки транспорта превращаются в "500 без тела".
    // Логи пойдут в stdout/stderr контейнера.
    console.error("[mcp-service] transport error:", err);
  };

  // Подключаем транспорт один раз; дальше handleRequest будет дергать onmessage.
  await server.connect(transport);

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
        const ready = server.isConnected();
        res.statusCode = ready ? 200 : 503;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: ready }));
        return;
      }

      if (url.pathname !== mcpPath) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method === "POST") {
        const len = Number(req.headers["content-length"] ?? "0");
        if (Number.isFinite(len) && len > maxBodyBytes) {
          res.statusCode = 413;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "payload too large" }));
          return;
        }

        // Важно: не читаем req body сами. `@hono/node-server` конвертирует Node.js request в Web Request,
        // и если заранее вычитать stream, конвертация может падать (500).
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method === "GET") {
        await transport.handleRequest(req, res);
        return;
      }

      res.statusCode = 405;
      res.setHeader("allow", "GET, POST");
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
