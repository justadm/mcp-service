import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Connector, RegisterContext } from "./types.js";
import type { OpenApiSourceConfig } from "../config.js";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

function loadSpec(specFile: string): any {
  const abs = path.isAbsolute(specFile)
    ? specFile
    : path.join(process.cwd(), specFile);
  const raw = fs.readFileSync(abs, "utf8");
  return YAML.parse(raw);
}

function isHttpMethod(x: string): x is HttpMethod {
  return (
    x === "get" ||
    x === "post" ||
    x === "put" ||
    x === "patch" ||
    x === "delete" ||
    x === "head" ||
    x === "options"
  );
}

function applyAuthHeaders(
  cfg: OpenApiSourceConfig,
  headers: Record<string, string>,
) {
  const auth = cfg.auth ?? { type: "none" as const };
  if (auth.type === "bearer") {
    const token = auth.token;
    if (!token) throw new Error(`[openapi:${cfg.id}] bearer auth: token не задан`);
    headers["authorization"] = `Bearer ${token}`;
  }
  if (auth.type === "header") {
    const value = auth.value;
    if (!value) throw new Error(`[openapi:${cfg.id}] header auth: value не задан`);
    headers[auth.name] = value;
  }
}

function joinUrl(baseUrl: string, p: string) {
  // Безопасно склеиваем без двойных слешей.
  const base = baseUrl.replace(/\/+$/, "");
  const tail = p.startsWith("/") ? p : `/${p}`;
  return `${base}${tail}`;
}

function buildPathWithParams(p: string, params: Record<string, unknown> | undefined) {
  if (!params) return p;
  return p.replace(/\{([^}]+)\}/g, (m, key) => {
    const v = (params as any)[key];
    if (v === undefined || v === null) return m;
    return encodeURIComponent(String(v));
  });
}

export function createOpenApiConnector(cfg: OpenApiSourceConfig): Connector {
  return {
    id: cfg.id,
    title: cfg.title,
    async register(ctx: RegisterContext) {
      const spec = loadSpec(cfg.specFile);
      const paths: any = spec?.paths;
      if (!paths || typeof paths !== "object") {
        throw new Error(
          `[openapi:${cfg.id}] В спецификации нет объекта 'paths' (или он не объект).`,
        );
      }

      const allowMethods = cfg.allowMethods?.map((m) => m.toLowerCase()) as
        | HttpMethod[]
        | undefined;
      const allowMethodsSet = allowMethods ? new Set(allowMethods) : undefined;

      const allowOpSet = cfg.allowOperationIds
        ? new Set(cfg.allowOperationIds.map((x) => x.trim()).filter(Boolean))
        : undefined;
      const denyOpSet = cfg.denyOperationIds
        ? new Set(cfg.denyOperationIds.map((x) => x.trim()).filter(Boolean))
        : undefined;

      for (const [p, pathItem] of Object.entries<any>(paths)) {
        if (!pathItem || typeof pathItem !== "object") continue;

        for (const [method, op] of Object.entries<any>(pathItem)) {
          if (!isHttpMethod(method)) continue;
          if (allowMethodsSet && !allowMethodsSet.has(method)) continue;
          if (!op || typeof op !== "object") continue;

          const operationId =
            (typeof op.operationId === "string" && op.operationId.trim()) || "";

          if (denyOpSet && operationId && denyOpSet.has(operationId)) continue;
          // Если задан allowlist по operationId, то операции без operationId пропускаем.
          if (allowOpSet && (!operationId || !allowOpSet.has(operationId))) continue;

          // Делаем стабильное имя инструмента даже без operationId.
          const toolName = `openapi_${cfg.id}_${operationId || `${method}_${p}`}`
            .replace(/[^\w]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 128);

          const descriptionParts: string[] = [];
          if (typeof op.summary === "string") descriptionParts.push(op.summary);
          if (typeof op.description === "string") descriptionParts.push(op.description);
          descriptionParts.push(`HTTP: ${method.toUpperCase()} ${p}`);
          const description = descriptionParts.filter(Boolean).join("\n\n");

          // Минимальный универсальный контракт ввода.
          // Дальше можно расширять: генерировать схему из OpenAPI.
          const inputSchema = z.object({
            params: z.record(z.string(), z.any()).optional(),
            query: z.record(z.string(), z.any()).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            body: z.any().optional(),
          });

          ctx.server.registerTool(toolName, { description, inputSchema }, async (input) => {
            const pathname = buildPathWithParams(p, input.params);
            const u = new URL(joinUrl(cfg.baseUrl, pathname));
            if (input.query) {
              for (const [k, v] of Object.entries(input.query)) {
                if (v === undefined || v === null) continue;
                u.searchParams.set(k, String(v));
              }
            }

            const headers: Record<string, string> = {
              accept: "application/json, text/plain;q=0.9, */*;q=0.1",
              ...(input.headers ?? {}),
            };
            applyAuthHeaders(cfg, headers);

            const hasBody = input.body !== undefined && input.body !== null;
            if (hasBody && !headers["content-type"]) {
              headers["content-type"] = "application/json";
            }

            const res = await fetch(u.toString(), {
              method: method.toUpperCase(),
              headers,
              body: hasBody
                ? headers["content-type"]?.includes("application/json")
                  ? JSON.stringify(input.body)
                  : String(input.body)
                : undefined,
            });

            const ct = res.headers.get("content-type") || "";
            let payload: any = null;
            try {
              if (ct.includes("application/json")) payload = await res.json();
              else payload = await res.text();
            } catch (e) {
              payload = { error: String(e) };
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: res.ok,
                      status: res.status,
                      statusText: res.statusText,
                      url: u.toString(),
                      data: payload,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          });
        }
      }
    },
  };
}
