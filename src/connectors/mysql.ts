import { z } from "zod";
import mysql from "mysql2/promise";
import type { Connector, RegisterContext } from "./types.js";
import type { MysqlSourceConfig } from "../config.js";

function isIdentifier(s: string) {
  // Упрощенная проверка идентификаторов SQL (MySQL). Без кавычек.
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

function qIdent(s: string) {
  if (!isIdentifier(s)) throw new Error(`Недопустимый идентификатор: ${s}`);
  return `\`${s}\``;
}

type TableRef = { db: string; table: string };

function parseTableRef(input: string, defaultDb: string): TableRef {
  const t = input.trim();
  if (!t) throw new Error("table не может быть пустым");
  const parts = t.split(".");
  if (parts.length === 1) return { db: defaultDb, table: parts[0]! };
  if (parts.length === 2) return { db: parts[0]!, table: parts[1]! };
  throw new Error("table должен быть в формате table или db.table");
}

export function createMysqlConnector(cfg: MysqlSourceConfig): Connector {
  return {
    id: cfg.id,
    title: cfg.title,
    async register(ctx: RegisterContext) {
      if (!cfg.connectionString) {
        throw new Error(
          `[mysql:${cfg.id}] connectionString не задан (ожидается после resolveSecrets).`,
        );
      }

      const pool = mysql.createPool(cfg.connectionString);
      const baseName = `mysql_${cfg.id}`.replace(/[^\w]+/g, "_");
      const hardMax = cfg.maxLimit ?? 1000;

      async function getDefaultDb() {
        const db = (cfg.database ?? "").trim();
        if (db) return db;
        const [rows] = await pool.query("select database() as db");
        const r0: any = Array.isArray(rows) ? rows[0] : null;
        const d = String(r0?.db ?? "").trim();
        if (!d) throw new Error(`[mysql:${cfg.id}] database не задан и текущая database() пуста`);
        return d;
      }

      const allowTablesSet = cfg.allowTables
        ? new Set(cfg.allowTables.map((t) => t.trim()).filter(Boolean))
        : undefined;

      async function assertTableAllowed(tableRef: TableRef) {
        if (allowTablesSet) {
          const key1 = `${tableRef.db}.${tableRef.table}`;
          const key2 = tableRef.table;
          if (!allowTablesSet.has(key1) && !allowTablesSet.has(key2)) {
            throw new Error(`Таблица запрещена allowTables: ${tableRef.db}.${tableRef.table}`);
          }
        }

        if (!isIdentifier(tableRef.db) || !isIdentifier(tableRef.table)) {
          throw new Error("Недопустимое имя db/table");
        }

        const [rows] = await pool.query(
          `
            select 1
            from information_schema.tables
            where table_schema = ?
              and table_name = ?
              and table_type = 'BASE TABLE'
            limit 1
          `,
          [tableRef.db, tableRef.table],
        );
        const ok = Array.isArray(rows) && rows.length > 0;
        if (!ok) throw new Error("Таблица не найдена");
      }

      async function listTables(db: string) {
        const [rows] = await pool.query(
          `
            select table_name
            from information_schema.tables
            where table_schema = ?
              and table_type = 'BASE TABLE'
            order by table_name
          `,
          [db],
        );
        const tables = (rows as any[]).map((x) => String(x.table_name));
        return allowTablesSet
          ? tables.filter((t) => allowTablesSet.has(`${db}.${t}`) || allowTablesSet.has(t))
          : tables;
      }

      async function describeTable(db: string, table: string) {
        const [rows] = await pool.query(
          `
            select
              column_name,
              data_type,
              is_nullable,
              column_default
            from information_schema.columns
            where table_schema = ?
              and table_name = ?
            order by ordinal_position
          `,
          [db, table],
        );
        return (rows as any[]).map((x) => ({
          name: String(x.column_name),
          type: String(x.data_type),
          nullable: String(x.is_nullable).toLowerCase() === "yes",
          default: x.column_default === null ? null : String(x.column_default),
        }));
      }

      ctx.server.registerTool(
        `${baseName}_list_tables`,
        {
          description: `Список таблиц (MySQL). database по умолчанию: ${cfg.database ?? "<auto>"}.`,
          inputSchema: z.object({
            database: z.string().min(1).optional(),
          }),
        },
        async (input) => {
          const db = input.database ?? (await getDefaultDb());
          if (!isIdentifier(db)) throw new Error("Недопустимое имя database");
          const tables = await listTables(db);
          return {
            content: [{ type: "text", text: JSON.stringify({ database: db, tables }, null, 2) }],
          };
        },
      );

      ctx.server.registerTool(
        `${baseName}_describe_table`,
        {
          description: `Описание колонок таблицы (MySQL).`,
          inputSchema: z.object({
            table: z.string().min(1),
            database: z.string().min(1).optional(),
          }),
        },
        async (input) => {
          const db = input.database ?? (await getDefaultDb());
          const tableRef = parseTableRef(input.table, db);
          await assertTableAllowed(tableRef);
          const columns = await describeTable(tableRef.db, tableRef.table);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { table: `${tableRef.db}.${tableRef.table}`, columns },
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
            `Безопасный SELECT по таблице (MySQL). ` +
            `Поддерживается только whereEq (равенство), лимиты и offset.`,
          inputSchema: z.object({
            table: z.string().min(1),
            database: z.string().min(1).optional(),
            columns: z.array(z.string().min(1)).optional(),
            whereEq: z
              .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
              .optional(),
            orderBy: z.string().min(1).optional(),
            orderDir: z.enum(["asc", "desc"]).optional().default("asc"),
            limit: z.number().int().min(1).optional().default(100),
            offset: z.number().int().min(0).optional().default(0),
          }),
        },
        async (input) => {
          const db = input.database ?? (await getDefaultDb());
          const tableRef = parseTableRef(input.table, db);
          await assertTableAllowed(tableRef);

          const limit = Math.min(input.limit, hardMax);
          const offset = input.offset;

          const cols = await describeTable(tableRef.db, tableRef.table);
          const colSet = new Set(cols.map((c) => c.name));

          const selectCols = input.columns && input.columns.length > 0 ? input.columns : ["*"];
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
              where.push(`${qIdent(k)} = ?`);
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
            `from ${qIdent(tableRef.db)}.${qIdent(tableRef.table)} ` +
            (where.length ? `where ${where.join(" and ")} ` : "") +
            orderClause +
            `limit ? offset ?`;

          values.push(limit, offset);

          const [rows] = await pool.query(sql, values);
          const arr = Array.isArray(rows) ? rows : [];
          const hasMore = arr.length === limit;
          const nextOffset = hasMore ? offset + limit : null;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    table: `${tableRef.db}.${tableRef.table}`,
                    limit,
                    offset,
                    nextOffset,
                    hasMore,
                    rows: arr,
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

