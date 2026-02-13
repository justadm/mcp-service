import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Connector, RegisterContext } from "./types.js";
import type { JsonSourceConfig } from "../config.js";

function absPath(p: string) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function loadJsonCached(cfg: JsonSourceConfig) {
  const file = absPath(cfg.file);
  const enc = (cfg.encoding ?? "utf8") as BufferEncoding;
  let lastMtimeMs: number | null = null;
  let lastDoc: any = null;

  return () => {
    const st = fs.statSync(file);
    if (lastMtimeMs !== null && lastMtimeMs === st.mtimeMs && lastDoc !== null) return lastDoc;
    const raw = fs.readFileSync(file, enc);
    lastDoc = JSON.parse(raw);
    lastMtimeMs = st.mtimeMs;
    return lastDoc;
  };
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

function encodePointerSegment(s: string) {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

function toPreview(v: any) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return v.length > 200 ? v.slice(0, 200) + "..." : v;
  if (t === "number" || t === "boolean") return String(v);
  if (Array.isArray(v)) return `[array len=${v.length}]`;
  if (t === "object") return `{object keys=${Object.keys(v).length}}`;
  return t;
}

function traverseFind(
  root: any,
  startPointer: string,
  query: string,
  where: "key" | "value" | "both",
  caseSensitive: boolean,
  limit: number,
) {
  const q = caseSensitive ? query : query.toLowerCase();
  const out: Array<{ pointer: string; match: "key" | "value"; key?: string; preview: string }> = [];

  const start = getByPointer(root, startPointer === "/" ? "" : startPointer);
  const stack: Array<{ v: any; ptr: string }> = [{ v: start, ptr: startPointer === "/" ? "" : startPointer }];

  while (stack.length && out.length < limit) {
    const { v, ptr } = stack.pop()!;
    if (v === null || v === undefined) continue;

    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) {
        stack.push({ v: v[i], ptr: `${ptr}/${i}` });
      }
      continue;
    }

    if (typeof v === "object") {
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i]!;
        const child = v[k];
        const childPtr = `${ptr}/${encodePointerSegment(k)}`;

        if (where === "key" || where === "both") {
          const hay = caseSensitive ? k : k.toLowerCase();
          if (hay.includes(q)) {
            out.push({ pointer: childPtr || "/", match: "key", key: k, preview: toPreview(child) });
            if (out.length >= limit) break;
          }
        }

        if (where === "value" || where === "both") {
          const t = typeof child;
          if (t === "string" || t === "number" || t === "boolean" || child === null) {
            const s = t === "string" ? (child as string) : JSON.stringify(child);
            const hay = caseSensitive ? s : s.toLowerCase();
            if (hay.includes(q)) {
              out.push({ pointer: childPtr || "/", match: "value", preview: toPreview(child) });
              if (out.length >= limit) break;
            }
          }
        }

        // Always traverse deeper for objects/arrays to find nested matches.
        if (typeof child === "object" && child !== null) {
          stack.push({ v: child, ptr: childPtr });
        }
      }
      continue;
    }

    // Primitive at start pointer.
    if (where === "value" || where === "both") {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      const hay = caseSensitive ? s : s.toLowerCase();
      if (hay.includes(q)) out.push({ pointer: ptr || "/", match: "value", preview: toPreview(v) });
    }
  }

  return out;
}

export function createJsonConnector(cfg: JsonSourceConfig): Connector {
  return {
    id: cfg.id,
    title: cfg.title,
    register(ctx: RegisterContext) {
      const baseName = `json_${cfg.id}`.replace(/[^\w]+/g, "_");
      const load = loadJsonCached(cfg);

      ctx.server.registerTool(
        `${baseName}_get`,
        {
          description: `Получить значение из JSON по JSON Pointer. Файл: ${cfg.file}.`,
          inputSchema: z.object({
            pointer: z.string().min(1),
          }),
        },
        async (input) => {
          const doc = load();
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
          const doc = load();
          const v = getByPointer(doc, input.pointer === "/" ? "" : input.pointer);
          const keys =
            v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : [];
          return { content: [{ type: "text", text: JSON.stringify(keys, null, 2) }] };
        },
      );

      ctx.server.registerTool(
        `${baseName}_find`,
        {
          description:
            `Поиск по ключам/значениям (строковое совпадение) с возвратом JSON Pointer. Файл: ${cfg.file}.`,
          inputSchema: z.object({
            query: z.string().min(1),
            where: z.enum(["key", "value", "both"]).optional().default("both"),
            pointer: z.string().min(1).optional().default("/"),
            caseSensitive: z.boolean().optional().default(false),
            limit: z.number().int().min(1).max(200).optional().default(20),
          }),
        },
        async (input) => {
          const doc = load();
          const matches = traverseFind(
            doc,
            input.pointer,
            input.query,
            input.where,
            input.caseSensitive,
            input.limit,
          );
          return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
        },
      );
    },
  };
}
