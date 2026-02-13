import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Connector, RegisterContext } from "./types.js";
import type { JsonSourceConfig } from "../config.js";

function absPath(p: string) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function loadJson(cfg: JsonSourceConfig): any {
  const raw = fs.readFileSync(absPath(cfg.file), (cfg.encoding ?? "utf8") as BufferEncoding);
  return JSON.parse(raw);
}

function getByPointer(doc: any, pointer: string): any {
  // RFC 6901 JSON Pointer (упрощенная реализация).
  if (pointer === "" || pointer === "/") return doc;
  if (!pointer.startsWith("/")) throw new Error("pointer должен начинаться с '/'");
  const parts = pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: any = doc;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isFinite(idx)) return undefined;
      cur = cur[idx];
    } else {
      cur = cur[part];
    }
  }
  return cur;
}

export function createJsonConnector(cfg: JsonSourceConfig): Connector {
  return {
    id: cfg.id,
    title: cfg.title,
    register(ctx: RegisterContext) {
      const baseName = `json_${cfg.id}`.replace(/[^\w]+/g, "_");

      ctx.server.registerTool(
        `${baseName}_get`,
        {
          description: `Получить значение из JSON по JSON Pointer. Файл: ${cfg.file}.`,
          inputSchema: z.object({
            pointer: z.string().min(1),
          }),
        },
        async (input) => {
          const doc = loadJson(cfg);
          const v = getByPointer(doc, input.pointer);
          return { content: [{ type: "text", text: JSON.stringify(v, null, 2) }] };
        },
      );

      ctx.server.registerTool(
        `${baseName}_keys`,
        {
          description: `Список ключей объекта JSON по JSON Pointer. Файл: ${cfg.file}.`,
          inputSchema: z.object({
            pointer: z.string().min(1).optional().default("/"),
          }),
        },
        async (input) => {
          const doc = loadJson(cfg);
          const v = getByPointer(doc, input.pointer === "/" ? "" : input.pointer);
          const keys =
            v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : [];
          return { content: [{ type: "text", text: JSON.stringify(keys, null, 2) }] };
        },
      );
    },
  };
}
