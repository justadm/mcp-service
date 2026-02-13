import { z } from "zod";
import pg from "pg";
import type { Connector, RegisterContext } from "./types.js";
import type { PostgresSourceConfig } from "../config.js";

const { Pool } = pg as unknown as typeof import("pg");

function isIdentifier(s: string) {
  // Упрощенная проверка идентификаторов SQL (Postgres). Без кавычек.
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

function qIdent(s: string) {
  // Разрешаем только безопасные идентификаторы без кавычек.
  if (!isIdentifier(s)) throw new Error(`Недопустимый идентификатор: ${s}`);
  return `"${s}"`;
}

type TableRef = { schema: string; table: string };

function parseTableRef(input: string, defaultSchema: string): TableRef {
  const t = input.trim();
  if (!t) throw new Error("table не может быть пустым");
  const parts = t.split(".");
  if (parts.length === 1) return { schema: defaultSchema, table: parts[0] };
  if (parts.length === 2) return { schema: parts[0]!, table: parts[1]! };
  throw new Error("table должен быть в формате table или schema.table");
}

async function listTables(pool: pg.Pool, schema: string): Promise<string[]> {
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
  return (r.rows as any[]).map((x) => String(x.table_name));
}

async function describeTable(
  pool: pg.Pool,
  schema: string,
  table: string,
): Promise<
  Array<{
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
  }>
> {
  const r = await pool.query(
    `
      select
        column_name,
        data_type,
        is_nullable,
        column_default
      from information_schema.columns
      where table_schema = $1
        and table_name = $2
      order by ordinal_position
    `,
    [schema, table],
  );
  return (r.rows as any[]).map((x) => ({
    name: String(x.column_name),
    type: String(x.data_type),
    nullable: String(x.is_nullable).toLowerCase() === "yes",
    default: x.column_default === null ? null : String(x.column_default),
  }));
}

export function createPostgresConnector(cfg: PostgresSourceConfig): Connector {
  return {
    id: cfg.id,
    title: cfg.title,
    async register(ctx: RegisterContext) {
      const pool = new Pool({ connectionString: cfg.connectionString });
      const baseName = `pg_${cfg.id}`.replace(/[^\w]+/g, "_");
      const defaultSchema = cfg.schema ?? "public";
      const hardMax = cfg.maxLimit ?? 1000;

      const allowTablesSet = cfg.allowTables
        ? new Set(cfg.allowTables.map((t) => t.trim()).filter(Boolean))
        : undefined;

      async function assertTableAllowed(tableRef: TableRef) {
        if (allowTablesSet) {
          const key1 = `${tableRef.schema}.${tableRef.table}`;
          const key2 = tableRef.table; // на случай, если пользователь укажет без схемы в allowlist
          if (!allowTablesSet.has(key1) && !allowTablesSet.has(key2)) {
            throw new Error(
              `Таблица запрещена allowTables: ${tableRef.schema}.${tableRef.table}`,
            );
          }
        }

        // Проверяем существование таблицы (и заодно отсекаем мусорные имена).
        if (!isIdentifier(tableRef.schema) || !isIdentifier(tableRef.table)) {
          throw new Error("Недопустимое имя schema/table");
        }

        const r = await pool.query(
          `
            select 1
            from information_schema.tables
            where table_schema = $1
              and table_name = $2
              and table_type = 'BASE TABLE'
            limit 1
          `,
          [tableRef.schema, tableRef.table],
        );
        if (r.rowCount === 0) throw new Error("Таблица не найдена");
      }

      ctx.server.registerTool(
        `${baseName}_list_tables`,
        {
          description: `Список таблиц (Postgres). schema по умолчанию: ${defaultSchema}.`,
          inputSchema: z.object({
            schema: z.string().min(1).optional().default(defaultSchema),
          }),
        },
        async (input) => {
          const schema = input.schema;
          if (!isIdentifier(schema)) throw new Error("Недопустимое имя schema");
          const tables = await listTables(pool, schema);
          const filtered = allowTablesSet
            ? tables.filter((t) => allowTablesSet.has(`${schema}.${t}`) || allowTablesSet.has(t))
            : tables;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ schema, tables: filtered }, null, 2),
              },
            ],
          };
        },
      );

      ctx.server.registerTool(
        `${baseName}_describe_table`,
        {
          description: `Описание колонок таблицы (Postgres).`,
          inputSchema: z.object({
            table: z.string().min(1),
            schema: z.string().min(1).optional(),
          }),
        },
        async (input) => {
          const tableRef = parseTableRef(input.table, input.schema ?? defaultSchema);
          await assertTableAllowed(tableRef);
          const columns = await describeTable(pool, tableRef.schema, tableRef.table);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    table: `${tableRef.schema}.${tableRef.table}`,
                    columns,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        },
      );

      ctx.server.registerTool(
        `${baseName}_select`,
        {
          description:
            `Безопасный SELECT по таблице (Postgres). ` +
            `Поддерживается только whereEq (равенство), лимиты и offset.`,
          inputSchema: z.object({
            table: z.string().min(1),
            schema: z.string().min(1).optional(),
            columns: z.array(z.string().min(1)).optional(),
            whereEq: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
            orderBy: z.string().min(1).optional(),
            orderDir: z.enum(["asc", "desc"]).optional().default("asc"),
            limit: z.number().int().min(1).optional().default(100),
            offset: z.number().int().min(0).optional().default(0),
          }),
        },
        async (input) => {
          const tableRef = parseTableRef(input.table, input.schema ?? defaultSchema);
          await assertTableAllowed(tableRef);

          const limit = Math.min(input.limit, hardMax);
          const offset = input.offset;

          // Колонки ограничиваем существующими колонками таблицы.
          const cols = await describeTable(pool, tableRef.schema, tableRef.table);
          const colSet = new Set(cols.map((c) => c.name));

          const selectCols =
            input.columns && input.columns.length > 0
              ? input.columns
              : ["*"];

          if (selectCols[0] !== "*") {
            for (const c of selectCols) {
              if (!colSet.has(c)) throw new Error(`Колонка не найдена: ${c}`);
              if (!isIdentifier(c)) throw new Error(`Недопустимое имя колонки: ${c}`);
            }
          }

          const where: string[] = [];
          const values: any[] = [];

          if (input.whereEq) {
            for (const [k, v] of Object.entries(input.whereEq)) {
              if (!colSet.has(k)) throw new Error(`Колонка не найдена: ${k}`);
              if (!isIdentifier(k)) throw new Error(`Недопустимое имя колонки: ${k}`);
              values.push(v);
              where.push(`${qIdent(k)} = $${values.length}`);
            }
          }

          let orderClause = "";
          if (input.orderBy) {
            const ob = input.orderBy;
            if (!colSet.has(ob)) throw new Error(`Колонка не найдена: ${ob}`);
            if (!isIdentifier(ob)) throw new Error(`Недопустимое имя колонки: ${ob}`);
            orderClause = ` order by ${qIdent(ob)} ${input.orderDir.toUpperCase()} `;
          }

          const sql =
            `select ${selectCols[0] === "*" ? "*" : selectCols.map(qIdent).join(", ")} ` +
            `from ${qIdent(tableRef.schema)}.${qIdent(tableRef.table)} ` +
            (where.length ? `where ${where.join(" and ")} ` : "") +
            orderClause +
            `limit $${values.length + 1} offset $${values.length + 2}`;

          values.push(limit, offset);

          const r = await pool.query(sql, values);
          const hasMore = r.rowCount === limit;
          const nextOffset = hasMore ? offset + limit : null;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    table: `${tableRef.schema}.${tableRef.table}`,
                    limit,
                    offset,
                    nextOffset,
                    hasMore,
                    rows: r.rows,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        },
      );
    },
  };
}
