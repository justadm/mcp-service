import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Connector, RegisterContext } from "./types.js";
import type { CsvSourceConfig } from "../config.js";

function absPath(p: string) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function loadCsv(cfg: CsvSourceConfig) {
  const raw = fs.readFileSync(absPath(cfg.file), (cfg.encoding ?? "utf8") as BufferEncoding);
  const records = parse(raw, {
    columns: cfg.hasHeader ?? true,
    delimiter: cfg.delimiter ?? ",",
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: true,
  });
  return records as any[];
}

export function createCsvConnector(cfg: CsvSourceConfig): Connector {
  return {
    id: cfg.id,
    title: cfg.title,
    register(ctx: RegisterContext) {
      const baseName = `csv_${cfg.id}`.replace(/[^\w]+/g, "_");

      ctx.server.registerTool(
        `${baseName}_list_rows`,
        {
          description: `Прочитать строки CSV из файла ${cfg.file}.`,
          inputSchema: z.object({
            offset: z.number().int().min(0).optional().default(0),
            limit: z.number().int().min(1).max(1000).optional().default(100),
          }),
        },
        async (input) => {
          const rows = loadCsv(cfg);
          const slice = rows.slice(input.offset, input.offset + input.limit);
          return {
            content: [{ type: "text", text: JSON.stringify(slice, null, 2) }],
          };
        },
      );

      ctx.server.registerTool(
        `${baseName}_filter_eq`,
        {
          description:
            `Фильтр по равенству значения в колонке (только для CSV с заголовком). ` +
            `Файл: ${cfg.file}.`,
          inputSchema: z.object({
            column: z.string().min(1),
            value: z.string(),
            limit: z.number().int().min(1).max(1000).optional().default(100),
          }),
        },
        async (input) => {
          const rows = loadCsv(cfg);
          const out: any[] = [];
          for (const r of rows) {
            const v = r?.[input.column];
            if (v === undefined || v === null) continue;
            if (String(v) === input.value) out.push(r);
            if (out.length >= input.limit) break;
          }
          return {
            content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          };
        },
      );
    },
  };
}
