import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type RegisterContext = {
  server: McpServer;
};

export interface Connector {
  id: string;
  title?: string;
  register(ctx: RegisterContext): Promise<void> | void;
}

