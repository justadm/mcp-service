import { loadConfigFile } from "./loadConfig.js";
import { runServer } from "./server.js";
import { probeConfig } from "./probe.js";

function usage() {
  // CLI минимальный: пока только запуск по конфигу.
  console.error("Использование:");
  console.error("  mcp-service --config <file.yml>");
  console.error("  mcp-service probe --config <file.yml>");
}

const args = process.argv.slice(2);
const sub = args[0];
let configPath: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--config" || a === "-c") configPath = args[i + 1];
  if (a === "--help" || a === "-h") {
    usage();
    process.exit(0);
  }
}

const cfg = loadConfigFile(configPath || process.env.MCP_SERVICE_CONFIG || "mcp-service.yml");
if (sub === "probe") {
  const report = await probeConfig(cfg);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  await runServer(cfg);
}
