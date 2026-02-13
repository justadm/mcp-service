import { loadConfigFile } from "./loadConfig.js";
import { runServer } from "./server.js";

const configPath = process.env.MCP_SERVICE_CONFIG || "mcp-service.yml";

const cfg = loadConfigFile(configPath);
await runServer(cfg);

