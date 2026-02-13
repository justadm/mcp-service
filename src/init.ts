import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

type InitType = "openapi" | "json" | "postgres" | "mysql";

export type InitOptions = {
  id: string;
  type: InitType;
  title?: string;
  projectPath?: string; // HTTP path, default: /p/<id>/mcp
  hostPort?: number; // 190xx
  // type-specific
  openapi?: {
    specFile?: string;
    baseUrl?: string;
    authType?: "none" | "bearer";
    authTokenEnv?: string; // for openapi.auth bearer
  };
  json?: {
    file?: string;
  };
  postgres?: {
    connectionStringEnv?: string;
    schema?: string;
  };
  mysql?: {
    connectionStringEnv?: string;
    database?: string;
  };
  // outputs
  outProjectFile?: string;
  outComposeFile?: string;
  // optional repo mutations
  updateEnvExample?: boolean;
  envExampleFile?: string;
  updateNginxConf?: boolean;
  nginxConfFile?: string;
};

export function validateProjectId(id: string) {
  const v = id.trim();
  if (!v) throw new Error("id не задан");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(v)) {
    throw new Error("id должен быть в формате: [a-z0-9][a-z0-9_-]*");
  }
  return v;
}

export function toProjectTokenEnv(id: string) {
  return `MCP_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BEARER_TOKEN`;
}

export function suggestNextHostPortFromComposeFiles(deployDir: string) {
  const files = fs
    .readdirSync(deployDir)
    .filter((f) => f.startsWith("docker-compose.nginx") && f.endsWith(".yml"));

  let max = 19000;
  for (const f of files) {
    const raw = fs.readFileSync(path.join(deployDir, f), "utf8");
    // matches: "127.0.0.1:19005:8080"
    for (const m of raw.matchAll(/127\.0\.0\.1:(19\d{3}):8080/g)) {
      const p = Number(m[1]);
      if (Number.isFinite(p) && p > max) max = p;
    }
  }
  return max + 1;
}

export function renderProjectYaml(opts: InitOptions) {
  const id = validateProjectId(opts.id);
  const projectPath = opts.projectPath?.trim() || `/p/${id}/mcp`;

  const transport: any = {
    type: "http",
    host: "0.0.0.0",
    port: 8080,
    path: projectPath,
    stateful: true,
    auth: { type: "bearer", tokenEnv: "MCP_BEARER_TOKEN" },
  };

  const sources: any[] = [];
  if (opts.type === "openapi") {
    const specFile = opts.openapi?.specFile?.trim() || "examples/petstore.openapi.yml";
    const baseUrl = opts.openapi?.baseUrl?.trim() || "https://example.com";
    const authType = opts.openapi?.authType || "none";
    const src: any = {
      id: "openapi_main",
      type: "openapi",
      specFile,
      baseUrl,
      auth:
        authType === "bearer"
          ? {
              type: "bearer",
              tokenEnv: opts.openapi?.authTokenEnv?.trim() || "OPENAPI_TOKEN",
            }
          : { type: "none" },
    };
    sources.push(src);
  } else if (opts.type === "json") {
    // Если задан host json file (будет смонтирован в compose), то внутри контейнера читаем фиксированный путь.
    const containerFile = opts.json?.file?.trim() ? "/app/data.json" : "examples/demo.json";
    sources.push({
      id: "json_main",
      type: "json",
      file: containerFile,
    });
  } else if (opts.type === "postgres") {
    sources.push({
      id: "pg_main",
      type: "postgres",
      connectionStringEnv: opts.postgres?.connectionStringEnv?.trim() || "PG_CONNECTION_STRING",
      schema: opts.postgres?.schema?.trim() || "public",
      maxLimit: 500,
    });
  } else if (opts.type === "mysql") {
    const src: any = {
      id: "mysql_main",
      type: "mysql",
      connectionStringEnv: opts.mysql?.connectionStringEnv?.trim() || "MYSQL_CONNECTION_STRING",
      maxLimit: 500,
    };
    if (opts.mysql?.database?.trim()) src.database = opts.mysql.database.trim();
    sources.push(src);
  } else {
    const _exhaustive: never = opts.type;
    return _exhaustive;
  }

  const cfg: any = {
    server: { name: "mcp-service", version: "0.1.0" },
    transport,
    sources,
  };
  return YAML.stringify(cfg);
}

export function renderComposeYaml(opts: InitOptions) {
  const id = validateProjectId(opts.id);
  const hostPort = opts.hostPort ?? 19001;
  const projectFile = `./projects/${id}.yml`;
  const tokenEnv = toProjectTokenEnv(id);

  const env: Record<string, string> = {
    MCP_SERVICE_CONFIG: "/app/project.yml",
    MCP_BEARER_TOKEN: `\${${tokenEnv}}`,
  };

  if (opts.type === "openapi" && opts.openapi?.authType === "bearer") {
    env.OPENAPI_TOKEN = "${OPENAPI_TOKEN}";
  }
  if (opts.type === "postgres") {
    env.PG_CONNECTION_STRING = "${PG_CONNECTION_STRING}";
  }
  if (opts.type === "mysql") {
    env.MYSQL_CONNECTION_STRING = "${MYSQL_CONNECTION_STRING}";
  }

  const svc: any = {
    image: "mcp-service:local",
    build: { context: ".." },
    environment: env,
    volumes: [`${projectFile}:/app/project.yml:ro`, "../examples:/app/examples:ro"],
    ports: [`127.0.0.1:${hostPort}:8080`],
    restart: "unless-stopped",
  };

  if (opts.type === "json" && opts.json?.file?.trim()) {
    // Это путь на хосте относительно deploy/ (compose файл живет в deploy/).
    // Монтируем его в фиксированный путь, который прописан в project.yml: /app/data.json
    const hostFile = opts.json.file.trim().startsWith("./") ? opts.json.file.trim() : `./${opts.json.file.trim()}`;
    (svc.volumes as any[]).push(`${hostFile}:/app/data.json:ro`);
  }

  if (opts.type === "mysql") {
    svc.extra_hosts = ["host.docker.internal:host-gateway"];
  }

  const dc: any = {
    services: {
      [`mcp_${id}`]: svc,
    },
  };
  return YAML.stringify(dc);
}

export function patchEnvExampleFile(filePath: string, additions: Record<string, string>) {
  const exists = fs.existsSync(filePath);
  const raw = exists ? fs.readFileSync(filePath, "utf8") : "";
  const lines = raw.split(/\r?\n/);
  const present = new Set(
    lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => l.split("=")[0]!.trim()),
  );

  const out = [...lines];
  let changed = false;
  for (const [k, v] of Object.entries(additions)) {
    if (present.has(k)) continue;
    out.push(`${k}=${v}`);
    changed = true;
  }

  if (changed) fs.writeFileSync(filePath, out.join("\n").replace(/\n+$/g, "\n") + "\n");
  return changed;
}

export function patchNginxHttpsConf(filePath: string, projectPath: string, hostPort: number) {
  const raw = fs.readFileSync(filePath, "utf8");
  const locLine = `    location = ${projectPath} {`;
  if (raw.includes(locLine)) return false;

  // Вставляем в server block для mcp.justgpt.ru (а не в justgpt.ru/app/api).
  const mcpServerNeedle = "\n    server_name mcp.justgpt.ru;\n";
  const mcpServerPos = raw.indexOf(mcpServerNeedle);
  if (mcpServerPos < 0) throw new Error("Не найден server_name mcp.justgpt.ru для вставки route");

  const insertionNeedle = "\n    location / {\n        return 404;\n    }\n";
  const insertionPoint = raw.indexOf(insertionNeedle, mcpServerPos);
  if (insertionPoint < 0) {
    throw new Error("Не найден блок 'location / { return 404; }' внутри server mcp.justgpt.ru");
  }

  const block =
    `\n    location = ${projectPath} {\n` +
    `        proxy_pass http://127.0.0.1:${hostPort};\n` +
    `        proxy_set_header Host $host;\n` +
    `        proxy_set_header X-Forwarded-Proto $scheme;\n` +
    `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n` +
    `        proxy_set_header Connection \"\";\n` +
    `    }\n`;

  const out = raw.slice(0, insertionPoint) + block + raw.slice(insertionPoint);
  fs.writeFileSync(filePath, out);
  return true;
}

function tryReadExistingProjectPath(projectFile: string): string | undefined {
  if (!fs.existsSync(projectFile)) return undefined;
  try {
    const raw = fs.readFileSync(projectFile, "utf8");
    const cfg: any = YAML.parse(raw);
    const p = (cfg?.transport?.path ?? "").toString().trim();
    return p || undefined;
  } catch {
    return undefined;
  }
}

function tryReadExistingHostPort(composeFile: string): number | undefined {
  if (!fs.existsSync(composeFile)) return undefined;
  try {
    const raw = fs.readFileSync(composeFile, "utf8");
    const dc: any = YAML.parse(raw);
    const services: any = dc?.services;
    if (!services || typeof services !== "object") return undefined;

    const svcKey = Object.keys(services)[0];
    const svc = services[svcKey];
    const ports: any[] = Array.isArray(svc?.ports) ? svc.ports : [];
    for (const p of ports) {
      if (typeof p !== "string") continue;
      // Examples:
      // - "127.0.0.1:19005:8080"
      // - "19005:8080"
      let m = p.match(/127\.0\.0\.1:(\d+):8080/);
      if (!m) m = p.match(/(^|:)(\d+):8080$/);
      const n = Number(m?.[1] ?? m?.[2]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function runInit(opts: InitOptions) {
  const id = validateProjectId(opts.id);
  const deployDir = path.join(process.cwd(), "deploy");

  const outProjectFile = opts.outProjectFile ?? path.join(deployDir, "projects", `${id}.yml`);
  const outComposeFile =
    opts.outComposeFile ?? path.join(deployDir, `docker-compose.nginx.${id}.yml`);

  fs.mkdirSync(path.dirname(outProjectFile), { recursive: true });
  fs.mkdirSync(path.dirname(outComposeFile), { recursive: true });

  const existingProjectPath = tryReadExistingProjectPath(outProjectFile);
  const existingHostPort = tryReadExistingHostPort(outComposeFile);

  const projectPath = opts.projectPath?.trim() || existingProjectPath || `/p/${id}/mcp`;
  const hostPort =
    opts.hostPort ??
    existingHostPort ??
    suggestNextHostPortFromComposeFiles(deployDir);

  let wroteProject = false;
  let wroteCompose = false;

  if (!fs.existsSync(outProjectFile)) {
    const projectYaml = renderProjectYaml({ ...opts, id, projectPath });
    fs.writeFileSync(outProjectFile, projectYaml);
    wroteProject = true;
  }

  if (!fs.existsSync(outComposeFile)) {
    const composeYaml = renderComposeYaml({ ...opts, id, hostPort });
    fs.writeFileSync(outComposeFile, composeYaml);
    wroteCompose = true;
  }

  const tokenEnv = toProjectTokenEnv(id);

  if (opts.updateEnvExample ?? true) {
    const envExample = opts.envExampleFile ?? path.join(deployDir, ".env.example");
    const additions: Record<string, string> = {
      [tokenEnv]: `change_me_${id}`,
    };
    if (opts.type === "postgres") additions.PG_CONNECTION_STRING = "change_me_pg_dsn";
    if (opts.type === "mysql") additions.MYSQL_CONNECTION_STRING = "change_me_mysql_dsn";
    if (opts.type === "openapi" && opts.openapi?.authType === "bearer") {
      additions.OPENAPI_TOKEN = "change_me_openapi_token";
    }
    patchEnvExampleFile(envExample, additions);
  }

  if (opts.updateNginxConf ?? true) {
    const nginxConf =
      opts.nginxConfFile ?? path.join(deployDir, "nginx", "justgpt.ru.https.conf");
    patchNginxHttpsConf(nginxConf, projectPath, hostPort);
  }

  return {
    id,
    projectPath,
    hostPort,
    outProjectFile,
    outComposeFile,
    tokenEnv,
    wroteProject,
    wroteCompose,
  };
}
