import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import pg from "pg";
import type { AppConfig, SourceConfig } from "./config.js";

const { Pool } = pg as unknown as typeof import("pg");

function absPath(p: string) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function loadYamlOrJson(file: string): any {
  const raw = fs.readFileSync(absPath(file), "utf8");
  return YAML.parse(raw);
}

function countOpenApiOperations(spec: any) {
  const paths: any = spec?.paths;
  if (!paths || typeof paths !== "object") return { operations: 0, tools: 0 };

  const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
  let ops = 0;
  for (const pathItem of Object.values<any>(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const k of Object.keys(pathItem)) {
      if (methods.has(String(k).toLowerCase())) ops += 1;
    }
  }

  // В текущем коннекторе 1 операция => 1 tool.
  return { operations: ops, tools: ops };
}

async function probeSource(src: SourceConfig) {
  if (src.type === "json") {
    const p = absPath(src.file);
    const st = fs.statSync(p);
    return {
      id: src.id,
      type: src.type,
      file: src.file,
      bytes: st.size,
    };
  }

  if (src.type === "csv") {
    const p = absPath(src.file);
    const st = fs.statSync(p);
    return {
      id: src.id,
      type: src.type,
      file: src.file,
      bytes: st.size,
      hasHeader: src.hasHeader ?? true,
      delimiter: src.delimiter ?? ",",
    };
  }

  if (src.type === "openapi") {
    const spec = loadYamlOrJson(src.specFile);
    const counts = countOpenApiOperations(spec);
    return {
      id: src.id,
      type: src.type,
      specFile: src.specFile,
      baseUrl: src.baseUrl,
      ...counts,
    };
  }

  if (src.type === "postgres") {
    if (!src.connectionString) {
      return {
        id: src.id,
        type: src.type,
        schema: src.schema ?? "public",
        allowTables: src.allowTables ?? null,
        maxLimit: src.maxLimit ?? 1000,
        ok: false,
        error:
          `[postgres:${src.id}] connectionString не задан (ожидается после resolveSecrets).`,
      };
    }
    const pool = new Pool({ connectionString: src.connectionString });
    try {
      const schema = src.schema ?? "public";
      try {
        const r = await pool.query(
          `
            select table_name
            from information_schema.tables
            where table_schema = $1
              and table_type = 'BASE TABLE'
            order by table_name
          `,
          [schema],
        );

        const tables = (r.rows as any[]).map((x) => String(x.table_name));
        const filtered = src.allowTables
          ? tables.filter(
              (t) =>
                src.allowTables!.includes(`${schema}.${t}`) || src.allowTables!.includes(t),
            )
          : tables;

        return {
          id: src.id,
          type: src.type,
          schema,
          allowTables: src.allowTables ?? null,
          tables: filtered,
          tablesCount: filtered.length,
          maxLimit: src.maxLimit ?? 1000,
          ok: true,
        };
      } catch (e) {
        return {
          id: src.id,
          type: src.type,
          schema,
          allowTables: src.allowTables ?? null,
          maxLimit: src.maxLimit ?? 1000,
          ok: false,
          error: String(e),
        };
      }
    } finally {
      await pool.end();
    }
  }

  const _exhaustive: never = src;
  return _exhaustive;
}

export async function probeConfig(cfg: AppConfig) {
  const startedAt = new Date().toISOString();
  const sources = [];
  for (const s of cfg.sources) {
    sources.push(await probeSource(s));
  }
  return { startedAt, sources };
}
