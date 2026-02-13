import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AppConfig } from "./config.js";
import { createConnector } from "./connectors/factory.js";
import { serveHttp } from "./httpTransport.js";

export async function runServer(config: AppConfig) {
  if (config.transport.type === "stdio") {
    const server = new McpServer({
      name: config.server.name,
      version: config.server.version,
    });

    for (const src of config.sources) {
      const c = createConnector(src);
      await c.register({ server });
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  if (config.transport.type === "http") {
    await serveHttp(config);
    return;
  }

  const _exhaustive: never = config.transport.type;
  return _exhaustive;
}
