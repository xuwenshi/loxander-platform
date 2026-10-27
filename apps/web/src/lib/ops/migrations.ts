import "server-only";

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { APP_ROOT } from "@/lib/app-root";

/**
 * 迁移状态：磁盘上有几份、库里应用了几份、还差哪几份。
 *
 * ── 判据与 `db/migrate.ts` 保持一致 ───────────────────────────────────
 * drizzle 的编程式 migrator 把已应用的迁移记在约定表
 * `drizzle.__drizzle_migrations` 里，每条一行，`hash` 是**迁移文件内容的
 * sha256 十六进制**，`created_at` 是文件里记录的 `when` 时间戳。
 * `db/migrate.ts:237-257` 判断「还差几份」用的是「库里行数 < 磁盘文件数」，
 * 因为 migrator 只会按顺序追加、从不跳号。这里沿用同一口径，
 * 另外把每份文件的 sha256 也算出来，用于回答「库里那份和磁盘这份是不是同一份」——
 * 这是行数口径答不了的问题（改过已应用的迁移文件时行数不变但内容变了）。
 *
 * ── 为什么只读 `public` 之外的 `drizzle` schema 也要查 ─────────────────
 * 它是唯一能回答「这次部署有没有把迁移跑上去」的地方。运维台的价值
 * 大半在这里：线上 500 最常见的原因就是「代码上去了、迁移没跑」。
 */

/** 磁盘上的一份迁移文件。 */
export interface MigrationFile {
  /** 文件名，如 `0002_auth_tables.sql`。 */
  file: string;
  /** journal 里的序号。文件名前缀解析失败时为 -1。 */
  idx: number;
  /** 语句条数（按 `--> statement-breakpoint` 切分后非空段数）。 */
  statements: number;
  bytes: number;
  /** 文件内容的 sha256（hex）。 */
  hash: string;
  /** 库里有同 hash 的记录 = 已应用。 */
  applied: boolean;
}

/** 迁移整体状态。 */
export interface MigrationStatus {
  /** 磁盘上的迁移目录绝对路径。 */
  directory: string;
  /** 库里的迁移记录表是否存在。 */
  trackingTableExists: boolean;
  /** 库里已应用的行数。 */
  appliedCount: number;
  files: MigrationFile[];
  /** 磁盘有、库里没有的文件名。 */
  pending: string[];
  /** 库里有、磁盘没有的 hash（说明库里跑过磁盘上已删掉的迁移）。 */
  orphanHashes: string[];
  /** 迁移记录表里最近一条的时间（ISO 字符串）。 */
  lastAppliedAt: string | null;
  /** 无法连接数据库时的错误信息。 */
  error?: string;
}

/** drizzle 约定的语句分隔符。与 `db/verify.ts` 的 `STATEMENT_BREAKPOINT` 同值。 */
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * 仓库根目录。
 *
 * `APP_ROOT` 是**应用根**（`apps/web`，判据是「有 content/ 且有 package.json」），
 * 而迁移目录在仓库根的 `db/migrations`，所以要从 `APP_ROOT` 往回退两级。
 *
 * 为什么不直接用 `process.cwd()`：`next start` 下 cwd 是仓库根、`next dev`
 * 从 `apps/web` 起时 cwd 是 `apps/web`，两种都对不上「稳定」。`APP_ROOT`
 * 已经把这两种形态归一化了，再从它推导比再写一次 cwd 猜测可靠。
 *
 * 兜底：如果退两级后没有 `db/migrations`，就试 `APP_ROOT` 本身（万一将来
 * 把 db/ 挪进 apps/web），再不行就返回退两级的路径 —— 让调用方看到
 * 「目录不存在」这个明确事实，而不是一个随 cwd 漂移的路径。
 */
function repoRoot(): string {
  const twoUp = path.resolve(APP_ROOT, "..", "..");
  if (existsSync(path.join(twoUp, "db", "migrations"))) return twoUp;
  if (existsSync(path.join(APP_ROOT, "db", "migrations"))) return APP_ROOT;
  return twoUp;
}

/** 迁移目录（仓库根下的 `db/migrations`）。 */
function migrationsDir(): string {
  return path.join(repoRoot(), "db", "migrations");
}

/** 按文件名排序列出磁盘上的迁移文件。 */
function readMigrationFiles(): { file: string; sql: string }[] {
  const dir = migrationsDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".sql"));
  } catch {
    return [];
  }
  names.sort((a, b) => a.localeCompare(b, "en"));
  return names.map((file) => ({ file, sql: readFileSync(path.join(dir, file), "utf8") }));
}

/** 数一份迁移里有几条语句。空段不算。 */
function countStatements(sql: string): number {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0).length;
}

/** 文件名前缀 → 序号。`0002_auth_tables.sql` → 2。 */
function indexOf(file: string): number {
  const match = /^(\d+)/.exec(file);
  return match ? Number(match[1]) : -1;
}

/**
 * 读迁移状态。**只读**：只 SELECT，不跑迁移、不改库。
 *
 * 数据库连不上时不抛异常 —— 运维台最该能打开的时刻就是「库连不上」的时刻，
 * 那时页面要能明确说「连不上，错误是 X」，而不是整个页面 500。
 */
export async function getMigrationStatus(databaseUrl: string | null): Promise<MigrationStatus> {
  const files = readMigrationFiles();
  const base: MigrationStatus = {
    directory: migrationsDir(),
    trackingTableExists: false,
    appliedCount: 0,
    files: files.map((f) => ({
      file: f.file,
      idx: indexOf(f.file),
      statements: countStatements(f.sql),
      bytes: Buffer.byteLength(f.sql, "utf8"),
      hash: createHash("sha256").update(f.sql).digest("hex"),
      applied: false,
    })),
    pending: [],
    orphanHashes: [],
    lastAppliedAt: null,
  };

  if (!databaseUrl) {
    return { ...base, error: "未配置 DATABASE_URL，无法读取库里的迁移记录。" };
  }

  const client = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
    connection: {
      application_name: "loxander-ops-migrations",
      default_transaction_read_only: true,
      statement_timeout: 15_000,
    },
  });

  try {
    const schemaRows = await client<{ n: number }[]>`
      select count(*)::int as n
      from information_schema.schemata
      where schema_name = 'drizzle'
    `;
    const trackingTableExists = (schemaRows[0]?.n ?? 0) > 0;

    if (!trackingTableExists) {
      return {
        ...base,
        pending: base.files.map((f) => f.file),
        error: "库里还没有 drizzle schema —— 说明一次迁移都没跑过。",
      };
    }

    const applied = await client<{ hash: string; created_at: string }[]>`
      select hash, created_at::text as created_at
      from drizzle.__drizzle_migrations
      order by created_at
    `;

    const appliedHashes = new Set(applied.map((r) => r.hash));
    const withApplied = base.files.map((f) => ({ ...f, applied: appliedHashes.has(f.hash) }));
    const diskHashes = new Set(withApplied.map((f) => f.hash));

    return {
      ...base,
      trackingTableExists: true,
      appliedCount: applied.length,
      files: withApplied,
      pending: withApplied.filter((f) => !f.applied).map((f) => f.file),
      orphanHashes: applied.map((r) => r.hash).filter((h) => !diskHashes.has(h)),
      lastAppliedAt: applied.length > 0 ? applied[applied.length - 1].created_at : null,
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}
