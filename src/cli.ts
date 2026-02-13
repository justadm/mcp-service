import { loadConfigFile } from "./loadConfig.js";
import { runServer } from "./server.js";
import { probeConfig } from "./probe.js";
import { runInit } from "./init.js";

function usage() {
  // CLI минимальный: пока только запуск по конфигу.
  console.error("Использование:");
  console.error("  mcp-service --config <file.yml>");
  console.error("  mcp-service probe --config <file.yml>");
  console.error(
    "  mcp-service init --id <projectId> --type <openapi|json|postgres|mysql> [--host-port 19006]",
  );
  console.error("Опции init:");
  console.error("  --path /p/<id>/mcp");
  console.error("  --out-project deploy/projects/<id>.yml");
  console.error("  --out-compose deploy/docker-compose.nginx.<id>.yml");
  console.error("  --no-update-env-example");
  console.error("  --no-update-nginx");
  console.error("  --nginx-conf deploy/nginx/justgpt.ru.https.conf");
  console.error("  --env-example deploy/.env.example");
  console.error("  (openapi) --openapi-spec <file> --openapi-base-url <url>");
  console.error("  (openapi) --openapi-auth none|bearer --openapi-token-env OPENAPI_TOKEN");
  console.error("  (mysql)   --mysql-database <db>");
  console.error("  (json)    --json-file ./data/<id>.json   (host file mounted into container)");
}

const args = process.argv.slice(2);
const sub = args[0];
let configPath: string | undefined;
let initId: string | undefined;
let initType: any;
let hostPort: number | undefined;
let projectPath: string | undefined;
let outProjectFile: string | undefined;
let outComposeFile: string | undefined;
let updateEnvExample: boolean | undefined;
let envExampleFile: string | undefined;
let updateNginxConf: boolean | undefined;
let nginxConfFile: string | undefined;
let openapiSpecFile: string | undefined;
let openapiBaseUrl: string | undefined;
let openapiAuthType: "none" | "bearer" | undefined;
let openapiTokenEnv: string | undefined;
let mysqlDatabase: string | undefined;
let jsonFile: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--config" || a === "-c") configPath = args[i + 1];
  if (a === "--help" || a === "-h") {
    usage();
    process.exit(0);
  }

  if (a === "--id") initId = args[i + 1];
  if (a === "--type") initType = args[i + 1];
  if (a === "--host-port") hostPort = Number(args[i + 1]);
  if (a === "--path") projectPath = args[i + 1];
  if (a === "--out-project") outProjectFile = args[i + 1];
  if (a === "--out-compose") outComposeFile = args[i + 1];

  if (a === "--update-env-example") updateEnvExample = true;
  if (a === "--no-update-env-example") updateEnvExample = false;
  if (a === "--env-example") envExampleFile = args[i + 1];

  if (a === "--update-nginx") updateNginxConf = true;
  if (a === "--no-update-nginx") updateNginxConf = false;
  if (a === "--nginx-conf") nginxConfFile = args[i + 1];

  if (a === "--openapi-spec") openapiSpecFile = args[i + 1];
  if (a === "--openapi-base-url") openapiBaseUrl = args[i + 1];
  if (a === "--openapi-auth") openapiAuthType = args[i + 1] as any;
  if (a === "--openapi-token-env") openapiTokenEnv = args[i + 1];

  if (a === "--mysql-database") mysqlDatabase = args[i + 1];
  if (a === "--json-file") jsonFile = args[i + 1];
}

if (sub === "init") {
  if (!initId || !initType) {
    usage();
    throw new Error("init требует --id и --type");
  }
  const res = runInit({
    id: initId,
    type: initType,
    hostPort,
    projectPath,
    outProjectFile,
    outComposeFile,
    updateEnvExample,
    envExampleFile,
    updateNginxConf,
    nginxConfFile,
    json: initType === "json" ? { file: jsonFile } : undefined,
    openapi:
      initType === "openapi"
        ? {
            specFile: openapiSpecFile,
            baseUrl: openapiBaseUrl,
            authType: openapiAuthType,
            authTokenEnv: openapiTokenEnv,
          }
        : undefined,
    mysql: initType === "mysql" ? { database: mysqlDatabase } : undefined,
  });
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        id: res.id,
        projectPath: res.projectPath,
        hostPort: res.hostPort,
        projectFile: res.outProjectFile,
        composeFile: res.outComposeFile,
        tokenEnv: res.tokenEnv,
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

const cfg = loadConfigFile(configPath || process.env.MCP_SERVICE_CONFIG || "mcp-service.yml");
if (sub === "probe") {
  const report = await probeConfig(cfg);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  await runServer(cfg);
}
