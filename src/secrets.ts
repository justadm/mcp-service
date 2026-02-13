import fs from "node:fs";
import path from "node:path";
import type { AppConfig, OpenApiSourceConfig, PostgresSourceConfig, SourceConfig } from "./config.js";

function absPath(p: string) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function readSecretFile(p: string) {
  return fs.readFileSync(absPath(p), "utf8").trim();
}

function readEnv(name: string) {
  return (process.env[name] ?? "").trim();
}

function resolveOpenApiAuth(src: OpenApiSourceConfig): OpenApiSourceConfig {
  const auth = src.auth;
  if (!auth || auth.type === "none") return src;

  if (auth.type === "bearer") {
    const token =
      (auth.token ?? "").trim() ||
      (auth.tokenFile ? readSecretFile(auth.tokenFile) : "") ||
      (auth.tokenEnv ? readEnv(auth.tokenEnv) : "");
    if (!token) {
      throw new Error(
        `[openapi:${src.id}] bearer auth требует token | tokenFile | tokenEnv.`,
      );
    }
    return { ...src, auth: { type: "bearer", token } };
  }

  if (auth.type === "header") {
    const value =
      (auth.value ?? "").trim() ||
      (auth.valueFile ? readSecretFile(auth.valueFile) : "") ||
      (auth.valueEnv ? readEnv(auth.valueEnv) : "");
    if (!value) {
      throw new Error(
        `[openapi:${src.id}] header auth требует value | valueFile | valueEnv.`,
      );
    }
    return { ...src, auth: { type: "header", name: auth.name, value } };
  }

  return src;
}

function resolvePostgres(src: PostgresSourceConfig): PostgresSourceConfig {
  const cs =
    (src.connectionString ?? "").trim() ||
    (src.connectionStringFile ? readSecretFile(src.connectionStringFile) : "") ||
    (src.connectionStringEnv ? readEnv(src.connectionStringEnv) : "");
  if (!cs) {
    throw new Error(
      `[postgres:${src.id}] требуется connectionString | connectionStringFile | connectionStringEnv.`,
    );
  }
  return { ...src, connectionString: cs };
}

function resolveSource(s: SourceConfig): SourceConfig {
  if (s.type === "openapi") return resolveOpenApiAuth(s);
  if (s.type === "postgres") return resolvePostgres(s);
  return s;
}

export function resolveSecrets(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    sources: cfg.sources.map(resolveSource),
  };
}

