import "server-only";

/**
 * 数据库结构浏览（只读）。
 *
 * ── 为什么不复用 `db/verify.ts` 里的 listColumns / listIndexes ───────────
 * 那两个函数签名要求传 `PGlite`（`db/verify.ts` 的测试库类型），而这里
 * 要连的是**真实 Postgres**。类型不兼容，硬套需要改 `db/verify.ts` 的公开
 * 契约，而那是 P2 的验收资产，不该为后台功能去动。
 *
 * 所以这里用同一套 `information_schema` / `pg_catalog` 查询，但走
 * postgres-js 原始连接。SQL 文本与 `db/verify.ts` 保持同样的语义，
 * 便于两边对照。
 */

import postgres from "postgres";

/** 一张表的概况。 */
export interface TableSummary {
  schema: string;
  name: string;
  /** 估算行数。来自 `pg_class.reltuples`，是统计信息而非精确值。 */
  estimatedRows: number;
  /** 表占用磁盘空间（人类可读，如 `8192 bytes`）。 */
  totalSize: string;
  /** 注释（`COMMENT ON TABLE`），没有则为 null。 */
  comment: string | null;
}

/** 一列。 */
export interface ColumnDetail {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  /** 是否为主键成员。 */
  isPrimaryKey: boolean;
  /** 字符最大长度（仅 varchar/char 有）。 */
  maxLength: number | null;
  /** 注释。 */
  comment: string | null;
}

/** 一个索引。 */
export interface IndexDetail {
  name: string;
  definition: string;
  isUnique: boolean;
  isPrimary: boolean;
}

/** 一个约束。 */
export interface ConstraintDetail {
  name: string;
  type: "primary key" | "foreign key" | "unique" | "check" | "exclusion" | string;
  definition: string;
}

/** 一个外键的解析结果，比 `pg_get_constraintdef` 的原始文本更好读。 */
export interface ForeignKeyDetail {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
}

/** 单表的完整结构。 */
export interface TableStructure {
  table: TableSummary;
  columns: ColumnDetail[];
  indexes: IndexDetail[];
  constraints: ConstraintDetail[];
  foreignKeys: ForeignKeyDetail[];
}

/** 建立一次性只读连接并执行查询，用完立即断开。 */
async function withReadOnlyClient<T>(
  databaseUrl: string,
  fn: (client: postgres.Sql) => Promise<T>,
): Promise<T> {
  const client = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
    connection: {
      application_name: "loxander-ops-schema",
      default_transaction_read_only: true,
      statement_timeout: 15_000,
    },
  });
  try {
    return await fn(client as unknown as postgres.Sql);
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * 列出 `public` schema 下的全部表，附带估算行数与磁盘占用。
 *
 * 只查 `public`：项目所有业务表都在 `public`，而 `drizzle` schema 下的
 * 迁移记录表由「迁移状态」页单独呈现，混在一起会让列表噪音很大。
 */
export async function listTables(databaseUrl: string): Promise<TableSummary[]> {
  return withReadOnlyClient(databaseUrl, async (client) => {
    const rows = await client<{
      table_name: string;
      estimated_rows: number | string;
      total_size: string;
      comment: string | null;
    }[]>`
      select
        c.relname                                    as table_name,
        greatest(c.reltuples, 0)::bigint             as estimated_rows,
        pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
        obj_description(c.oid, 'pg_class')           as comment
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
      order by c.relname
    `;

    return rows.map((r) => ({
      schema: "public",
      name: r.table_name,
      // reltuples 是 real，`-1` 表示从未 analyze 过；上面已用 greatest 归零。
      estimatedRows: Number(r.estimated_rows),
      totalSize: r.total_size,
      comment: r.comment,
    }));
  });
}

/** 读取单表的结构（列 / 索引 / 约束 / 外键）。 */
export async function getTableStructure(
  databaseUrl: string,
  table: string,
): Promise<TableStructure | null> {
  return withReadOnlyClient(databaseUrl, async (client) => {
    // 先确认表存在，避免后面四条查询都返回空数组而让人以为「表是空的」。
    const meta = await client<{
      estimated_rows: number | string;
      total_size: string;
      comment: string | null;
    }[]>`
      select
        greatest(c.reltuples, 0)::bigint             as estimated_rows,
        pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
        obj_description(c.oid, 'pg_class')           as comment
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = ${table} and c.relkind = 'r'
    `;

    if (meta.length === 0) return null;

    const columns = await client<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
      comment: string | null;
    }[]>`
      select
        col.column_name,
        col.data_type,
        col.is_nullable,
        col.column_default,
        col.character_maximum_length,
        col_description(c.oid, col.ordinal_position::int) as comment
      from information_schema.columns col
      join pg_class c on c.relname = col.table_name
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = col.table_schema
      where col.table_schema = 'public' and col.table_name = ${table}
      order by col.ordinal_position
    `;

    // 主键列集合，用于在列上打 isPrimaryKey 标记。
    const pkCols = await client<{ column_name: string }[]>`
      select kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
       and kcu.table_schema = tc.table_schema
       and kcu.table_name = tc.table_name
      where tc.table_schema = 'public'
        and tc.table_name = ${table}
        and tc.constraint_type = 'PRIMARY KEY'
    `;
    const pkSet = new Set(pkCols.map((r) => r.column_name));

    const indexes = await client<{
      indexname: string;
      indexdef: string;
    }[]>`
      select i.relname as indexname, pg_get_indexdef(ix.indexrelid) as indexdef
      from pg_index ix
      join pg_class i on i.oid = ix.indexrelid
      join pg_class t on t.oid = ix.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = ${table}
      order by i.relname
    `;

    const constraints = await client<{
      conname: string;
      contype: string;
      condef: string;
    }[]>`
      select
        con.conname,
        con.contype::text as contype,
        pg_get_constraintdef(con.oid) as condef
      from pg_constraint con
      join pg_class t on t.oid = con.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = ${table}
      order by con.conname
    `;

    const fkRows = await client<{
      conname: string;
      local_cols: string;
      ref_table: string;
      ref_cols: string;
      delete_action: string;
      update_action: string;
    }[]>`
      select
        con.conname,
        (
          select string_agg(a.attname, ',' order by k.ord)
          from unnest(con.conkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
        ) as local_cols,
        (
          select c2.relname from pg_class c2 where c2.oid = con.confrelid
        ) as ref_table,
        (
          select string_agg(a2.attname, ',' order by k2.ord)
          from unnest(con.confkey) with ordinality as k2(attnum, ord)
          join pg_attribute a2 on a2.attrelid = con.confrelid and a2.attnum = k2.attnum
        ) as ref_cols,
        con.confdeltype::text as delete_action,
        con.confupdtype::text as update_action
      from pg_constraint con
      join pg_class t on t.oid = con.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = ${table} and con.contype = 'f'
      order by con.conname
    `;

    // confdeltype / confupdtype 是单字符代码，翻译成可读动作。
    const actionOf = (code: string): string => {
      switch (code) {
        case "a":
          return "NO ACTION";
        case "r":
          return "RESTRICT";
        case "c":
          return "CASCADE";
        case "n":
          return "SET NULL";
        case "d":
          return "SET DEFAULT";
        default:
          return code;
      }
    };

    const constraintTypeOf = (code: string): string => {
      switch (code) {
        case "p":
          return "primary key";
        case "f":
          return "foreign key";
        case "u":
          return "unique";
        case "c":
          return "check";
        case "x":
          return "exclusion";
        default:
          return code;
      }
    };

    return {
      table: {
        schema: "public",
        name: table,
        estimatedRows: Number(meta[0].estimated_rows),
        totalSize: meta[0].total_size,
        comment: meta[0].comment,
      },
      columns: columns.map((c) => ({
        name: c.column_name,
        dataType: c.data_type,
        nullable: c.is_nullable === "YES",
        defaultValue: c.column_default,
        isPrimaryKey: pkSet.has(c.column_name),
        maxLength: c.character_maximum_length,
        comment: c.comment,
      })),
      indexes: indexes.map((i) => ({
        name: i.indexname,
        definition: i.indexdef,
        isUnique: i.indexdef.includes("UNIQUE INDEX"),
        isPrimary: i.indexdef.includes("_pkey"),
      })),
      constraints: constraints.map((c) => ({
        name: c.conname,
        type: constraintTypeOf(c.contype),
        definition: c.condef,
      })),
      foreignKeys: fkRows.map((f) => ({
        name: f.conname,
        columns: f.local_cols ? f.local_cols.split(",") : [],
        referencedTable: f.ref_table,
        referencedColumns: f.ref_cols ? f.ref_cols.split(",") : [],
        onDelete: actionOf(f.delete_action),
        onUpdate: actionOf(f.update_action),
      })),
    };
  });
}
