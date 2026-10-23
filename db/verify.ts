/**
 * PGlite 迁移闸门：在**没有真实 Postgres** 的机器上验证 `db/migrations/0000_init.sql`
 * 确实能建出 `db/schema.ts` 声明的 7 张表，并且所有 CHECK / UNIQUE / FK 级联都真的生效。
 *
 * 为什么用 PGlite 而不是连 Neon：
 *   本机沙箱禁止管道 stdio 子进程（`spawn EPERM`），也起不了 Postgres 服务；
 *   PGlite 是 Postgres 18.6 编译到 wasm，跑在进程内、纯内存，不 spawn 任何子进程。
 *
 * 本文件只做「跑迁移 + 查询元数据」，不做断言 —— 断言在 `db/verify.test.ts`。
 * 这样 compare.ts 之类需要「一个已迁移的空库」的脚本也能直接复用。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 迁移目录（`db/generate-migration.ts` 的产物落在这里）。 */
export const MIGRATIONS_DIR: string = join(HERE, 'migrations');

/** 首份迁移的绝对路径（保留导出：单文件场景仍需要它）。 */
export const MIGRATION_PATH: string = join(MIGRATIONS_DIR, '0000_init.sql');

/**
 * 全部迁移文件，按文件名（即 `0000_` / `0001_` 前缀）升序。
 *
 * 必须**全量按序**执行：PGlite 闸门验证的是「从空库一路 migrate 到最新」这条路径，
 * 等价于真库上 `migrate()` 的效果。只跑 0000 会让后续 ALTER 类迁移完全失去覆盖
 * （例如 0001 给 entry_tags 加 `tag_order`）。
 */
export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => join(dir, name));
}

/** drizzle 的分句分隔符，`generate-migration.ts` 生成时用的就是这个。 */
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/**
 * 迁移期望建出的表（顺序无关，比对用）。
 *
 * 7 张业务表（P2）+ 4 张认证表（P4，迁移 `0002_auth_tables.sql`：
 * `accounts` / `sessions` / `users` / `verification_tokens`）= 11 张。
 */
export const EXPECTED_TABLES: readonly string[] = [
  'accounts',
  'audit_logs',
  'entries',
  'entry_revisions',
  'entry_tags',
  'media',
  'redirects',
  'sessions',
  'tags',
  'users',
  'verification_tokens',
];

/**
 * `entries` 表的列名，必须与 `db/schema.ts` 的 `entries` 定义逐字一致。
 *
 * 注意 `publish_status`（不是 `status`）、`display_date`、`sort_order`、`data`、
 * `version`、`created_by` / `updated_by` —— 这几个是审查意见里点名要求过的形状。
 */
export const EXPECTED_ENTRY_COLUMNS: readonly string[] = [
  'id',
  'kind',
  'slug',
  'title',
  'summary',
  'body_md',
  'body_html',
  'publish_status',
  'featured',
  'sort_order',
  'published_at',
  'display_date',
  'data',
  'version',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
];

/**
 * `entry_tags` 表的列名，必须与 `db/schema.ts` 逐字一致。
 *
 * `tag_order` 是 P2 追加的列（迁移 `0001_entry_tag_order.sql`）：
 * 方案 §6.3 的原 DDL 只有 (entry_id, tag_id)，读回时只能 `order by tag_id`，
 * 而 tag_id 是 bigserial，反映的是标签全局首次插入顺序，不是单篇 frontmatter
 * 顺序 —— 实测 4 篇有标签的 blog 里已有 1 篇会还原错序。
 */
export const EXPECTED_ENTRY_TAG_COLUMNS: readonly string[] = ['entry_id', 'tag_id', 'tag_order'];

/**
 * 每份迁移文件的语句条数（断言它防止文件被截断或被手工编辑）。
 *
 * `0000_init.sql`：16 个分隔符 → 17 条语句。
 * `0001_entry_tag_order.sql`：ALTER ADD COLUMN + CREATE INDEX → 2 条。
 * `0002_auth_tables.sql`：4 CREATE TABLE + 6 外键 + 3 索引 → 13 条。
 */
export const EXPECTED_STATEMENT_COUNTS: Readonly<Record<string, number>> = {
  '0000_init.sql': 17,
  '0001_entry_tag_order.sql': 2,
  '0002_auth_tables.sql': 13,
};

/** 全部迁移语句条数之和。 */
export const EXPECTED_STATEMENT_COUNT = Object.values(EXPECTED_STATEMENT_COUNTS).reduce(
  (sum, count) => sum + count,
  0,
);

/* -------------------------------------------------------------------------- */
/* 迁移执行                                                                    */
/* -------------------------------------------------------------------------- */

/** 去掉纯注释块，避免把「只有注释」的片段当 SQL 执行。 */
function hasExecutableSql(statement: string): boolean {
  return statement
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith('--'));
}

/**
 * 按 `--> statement-breakpoint` 切分迁移文件。
 *
 * 首段会带上文件头的 3 行 `--` 注释，这不影响执行（Postgres 直接忽略），
 * 所以只过滤「切完只剩空白/注释」的尾巴，不剥注释。
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && hasExecutableSql(chunk));
}

/** 读迁移原文（UTF-8，无 BOM）。 */
export function loadMigrationSql(path: string = MIGRATION_PATH): string {
  return readFileSync(path, 'utf8');
}

export interface MigratedDatabase {
  db: PGlite;
  /** 实际执行的语句，按顺序。 */
  statements: string[];
  /** 实际执行过的迁移文件名（升序），报告里贴出来便于确认覆盖到哪一份。 */
  appliedFiles: string[];
}

/**
 * 起一个**纯内存** PGlite 并把**全部**迁移文件按序逐条执行完。
 *
 * 失败时抛出带「文件名 + 语句序号」的错误 —— 迁移文件是生成物，出错时最需要
 * 知道是哪一份的第几条。
 *
 * 不传 `migrationPath` 时按文件名顺序跑 `db/migrations/*.sql` 全量；
 * 传了则只跑指定的那一份（单文件调试用）。
 */
export async function createMigratedDatabase(
  options: { migrationPath?: string } = {},
): Promise<MigratedDatabase> {
  const db = await PGlite.create();
  const files = options.migrationPath ? [options.migrationPath] : listMigrationFiles();
  const statements: string[] = [];
  const appliedFiles: string[] = [];

  for (const file of files) {
    const fileStatements = splitStatements(loadMigrationSql(file));
    appliedFiles.push(file.split(/[\\/]/).pop() ?? file);

    for (let index = 0; index < fileStatements.length; index += 1) {
      try {
        await db.exec(fileStatements[index]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `迁移 ${appliedFiles[appliedFiles.length - 1]} 第 ${index + 1}/${fileStatements.length} 条语句执行失败：\n` +
            `${fileStatements[index]}\n---\n${message}`,
        );
      }
      statements.push(fileStatements[index]);
    }
  }

  return { db, statements, appliedFiles };
}

/* -------------------------------------------------------------------------- */
/* 元数据查询                                                                  */
/* -------------------------------------------------------------------------- */

export interface ColumnInfo {
  name: string;
  dataType: string;
  notNull: boolean;
  defaultExpr: string | null;
}

export interface ConstraintInfo {
  name: string;
  type: string;
  definition: string;
}

export interface IndexInfo {
  name: string;
  definition: string;
  unique: boolean;
}

/** `public` schema 下的表名，按字母序。 */
export async function listTables(db: PGlite): Promise<string[]> {
  const result = await db.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  return result.rows.map((row) => row.tablename);
}

/** 某张表的列名（按 ordinal 顺序）。 */
export async function listColumns(db: PGlite, table: string): Promise<ColumnInfo[]> {
  const result = await db.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [table],
  );

  return result.rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
    notNull: row.is_nullable === 'NO',
    defaultExpr: row.column_default,
  }));
}

/**
 * 某张表的约束（含 CHECK 的完整定义文本）。
 *
 * 用 `pg_get_constraintdef` 而不是自己拼 —— CHECK 表达式的文本是我们要断言的
 * 事实本身（例如 `kind in ('blog','diary','projects','goals')`）。
 */
export async function listConstraints(db: PGlite, table: string): Promise<ConstraintInfo[]> {
  const result = await db.query<{ conname: string; contype: string; definition: string }>(
    `select c.conname, c.contype::text as contype, pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = $1
      order by c.conname`,
    [table],
  );

  return result.rows.map((row) => ({
    name: row.conname,
    type: row.contype,
    definition: row.definition,
  }));
}

/** 某张表上的索引（含 UNIQUE 标记与定义文本）。 */
export async function listIndexes(db: PGlite, table: string): Promise<IndexInfo[]> {
  const result = await db.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = $1
      order by indexname`,
    [table],
  );

  return result.rows.map((row) => ({
    name: row.indexname,
    definition: row.indexdef,
    unique: /create\s+unique\s+index/i.test(row.indexdef),
  }));
}

/* -------------------------------------------------------------------------- */
/* 执行辅助                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 断言一条 SQL **必须失败**，返回 Postgres 的错误信息。
 *
 * 之所以返回错误文本而不是布尔：测试里要把「因为什么失败」也断言一遍，
 * 否则一个拼写错误导致的失败会被误当成「约束生效了」。
 */
export async function expectFailure(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`期望这条 SQL 失败，但它成功了：\n${sql}`);
}

/** 断言一条 SQL **必须成功**，返回受影响行数。 */
export async function expectSuccess(
  db: PGlite,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const result = await db.query(sql, params);
  return result.affectedRows ?? 0;
}

/**
 * 插入一条最小的合法 entries 行，返回 id。
 *
 * 只填 `kind` / `slug` / `title`（其余列都有默认值），这样测试聚焦在被验证的约束上。
 */
export async function insertEntry(
  db: PGlite,
  kind: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const columns = ['kind', 'slug', 'title', ...Object.keys(overrides)];
  const values = [kind, slug, `probe ${kind}/${slug}`, ...Object.values(overrides)];
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');

  const result = await db.query<{ id: string }>(
    `insert into entries (${columns.map((c) => `"${c}"`).join(', ')})
     values (${placeholders}) returning id`,
    values,
  );
  return result.rows[0].id;
}

/**
 * `gen_random_uuid()` 在 PGlite 里到底能不能用。
 *
 * 这是任务书里点名的决策点：如果不可用，schema 的 `DEFAULT gen_random_uuid()`
 * 就要改契约。结论写进 `db/verify.test.ts` 的测试里，任何回归都会被拦住。
 */
export async function probeGenRandomUuid(
  db: PGlite,
): Promise<{ available: boolean; sample?: string; error?: string }> {
  try {
    const result = await db.query<{ u: string }>('select gen_random_uuid() as u');
    return { available: true, sample: result.rows[0].u };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** PGlite / Postgres 版本号，报告里贴一行就够。 */
export async function probeServerVersion(db: PGlite): Promise<string> {
  const result = await db.query<{ v: string }>('select version() as v');
  return String(result.rows[0].v).split(' on ')[0];
}
