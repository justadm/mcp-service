import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";

async function readJsonBody(req: http.IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) throw new Error("Слишком большой body");
    chunks.push(b);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

export async function serveHttp(server: McpServer, cfg: AppConfig["transport"]) {
  const host = cfg.host ?? "0.0.0.0";
  const port = cfg.port ?? 8080;
  const mcpPath = cfg.path ?? "/mcp";
  const stateful = cfg.stateful ?? true;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: stateful ? () => randomUUID() : undefined,
  });

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
        const parsedBody = await readJsonBody(req, 1_000_000);
        await transport.handleRequest(req, res, parsedBody);
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
