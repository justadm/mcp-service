import { z } from "zod";

const SourceBase = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
});

export const OpenApiSourceConfig = SourceBase.extend({
  type: z.literal("openapi"),
  specFile: z.string().min(1),
  baseUrl: z.string().min(1),
  auth: z
    .union([
      z.object({ type: z.literal("none") }),
      z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
      z.object({
        type: z.literal("header"),
        name: z.string().min(1),
        value: z.string().min(1),
      }),
    ])
    .optional(),
});

export const CsvSourceConfig = SourceBase.extend({
  type: z.literal("csv"),
  file: z.string().min(1),
  delimiter: z.string().min(1).optional(),
  encoding: z.string().min(1).optional(),
  hasHeader: z.boolean().optional().default(true),
});

export const JsonSourceConfig = SourceBase.extend({
  type: z.literal("json"),
  file: z.string().min(1),
  encoding: z.string().min(1).optional(),
});

export const PostgresSourceConfig = SourceBase.extend({
  type: z.literal("postgres"),
  connectionString: z.string().min(1),
  schema: z.string().min(1).optional().default("public"),
  // Если задано, ограничиваем доступ только этими таблицами.
  allowTables: z.array(z.string().min(1)).optional(),
  // Жесткий верхний лимит выдачи строк для инструментов чтения.
  maxLimit: z.number().int().min(1).max(5000).optional().default(1000),
});

export const SourceConfig = z.discriminatedUnion("type", [
  OpenApiSourceConfig,
  CsvSourceConfig,
  JsonSourceConfig,
  PostgresSourceConfig,
]);

export const AppConfig = z.object({
  server: z.object({
    name: z.string().min(1).default("mcp-service"),
    version: z.string().min(1).default("0.1.0"),
  }),
  transport: z
    .object({
      type: z.enum(["stdio", "http"]).default("stdio"),
      // используется только для http
      host: z.string().min(1).optional().default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).optional().default(8080),
      path: z.string().min(1).optional().default("/mcp"),
      // stateful: сервер выдает sessionId и валидирует его.
      // stateless: sessionIdGenerator = undefined.
      stateful: z.boolean().optional().default(true),
    })
    .default({
      type: "stdio",
      host: "0.0.0.0",
      port: 8080,
      path: "/mcp",
      stateful: true,
    }),
  sources: z.array(SourceConfig).min(1),
});

export type AppConfig = z.infer<typeof AppConfig>;
export type SourceConfig = z.infer<typeof SourceConfig>;
export type OpenApiSourceConfig = z.infer<typeof OpenApiSourceConfig>;
export type CsvSourceConfig = z.infer<typeof CsvSourceConfig>;
export type JsonSourceConfig = z.infer<typeof JsonSourceConfig>;
export type PostgresSourceConfig = z.infer<typeof PostgresSourceConfig>;
