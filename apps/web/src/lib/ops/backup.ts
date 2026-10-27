import "server-only";

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { APP_ROOT } from "@/lib/app-root";

/**
 * 逻辑备份（只读导出 + 只读比对）。**不提供恢复**。
 *
 * ── 为什么运维台不做「恢复」────────────────────────────────────────────
 * 用户在立项时明确选了「数据库只读」。恢复是写操作，而且是**破坏性**写
 * （`insert ... on conflict do nothing` 之外还要考虑删多余行）。把它放进
 * 一个浏览器页面里，等于让一次误点改写生产数据。所以恢复留在终端：
 * `npm run db:restore`（`scripts/db-backup.mjs`），那里有 `--dry-run`、
 * 有交互确认、有完整的错误上下文。运维台只负责「看清楚现在有什么备份」。
 *
 * ── 为什么不直接 import `scripts/db-backup.mjs` ───────────────────────
 * 那个脚本末尾是 `main().then(code => process.exit(code))`，没有
 * `invokedDirectly` 守卫。进程内 import 它会在 import 期间就执行
 * `loadEnv()` 并**直接 `process.exit`**，把整个 Next 服务进程杀掉。
 * 所以这里用同一套表清单与同一套 dump 逻辑重写一遍（约 120 行），
 * 换来的是「运维台进程不会被脚本的 CLI 入口带走」。
 *
 * 两边的一致性由「表清单必须与 `scripts/db-backup.mjs:50-61` 相同」
 * 这条注释约束，并在 `__tests__/ops-backup.test.ts` 里做文本比对。
 */

/**
 * 备份范围与恢复顺序（父表在前）。
 *
 * **必须与 `scripts/db-backup.mjs:50-61` 的 `TABLES` 完全一致**，
 * 否则运维台看到的备份文件与终端恢复脚本会互相不认。
 */
export const BACKUP_TABLES = [
  "users",
  "accounts",
  "sessions",
  "verification_tokens",
  "entries",
  "entry_revisions",
  "tags",
  "entry_tags",
  "media",
  "redirects",
  "audit_logs",
] as const;

/** 一个已存在的备份文件。 */
export interface BackupFileInfo {
  file: string;
  absolutePath: string;
  bytes: number;
  /** 文件最后修改时间（ISO）。 */
  modifiedAt: string;
  /** 备份创建时间（文件内容里的 `createdAt`），解析失败为 null。 */
  createdAt: string | null;
  /** 每张表的行数，解析失败为空对象。 */
  rowCounts: Record<string, number>;
  /** 备份里的总行数。 */
  totalRows: number;
  /** 备份时的 schema 版本（如果有）。 */
  schemaVersion: string | null;
  /** 解析失败的原因。 */
  error?: string;
}

/** 一次 dump 的结果。 */
export interface BackupResult {
  ok: boolean;
  file?: string;
  bytes?: number;
  totalRows?: number;
  rowCounts?: Record<string, number>;
  elapsedMs: number;
  error?: string;
}

/** 备份目录（仓库根下的 `backups/`）。 */
function backupsDir(): string {
  const twoUp = path.resolve(APP_ROOT, "..", "..");
  const base = existsSync(path.join(twoUp, "db")) ? twoUp : APP_ROOT;
  return path.join(base, "backups");
}

/** 时间戳文件名，与 `scripts/db-backup.mjs` 同格式。 */
function timestampName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `db-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`
  );
}

/**
 * 列出已有备份，并把每个文件的行数摘要读出来。
 *
 * 读整份文件而不是只 `stat`：页面上最有用的信息是「这份备份里有多少行」，
 * 只给文件大小无法判断它是不是空壳。备份文件是几十 KB 量级，全读没有压力。
 */
export function listBackups(): BackupFileInfo[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((file) => {
      const absolutePath = path.join(dir, file);
      const stat = statSync(absolutePath);
      const info: BackupFileInfo = {
        file,
        absolutePath,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        createdAt: null,
        rowCounts: {},
        totalRows: 0,
        schemaVersion: null,
      };

      try {
        const payload = JSON.parse(readFileSync(absolutePath, "utf8")) as {
          createdAt?: string;
          schemaVersion?: string;
          tables?: Record<string, unknown[]>;
        };
        info.createdAt = typeof payload.createdAt === "string" ? payload.createdAt : null;
        info.schemaVersion =
          typeof payload.schemaVersion === "string" ? payload.schemaVersion : null;
        const tables = payload.tables ?? {};
        for (const [table, rows] of Object.entries(tables)) {
          const count = Array.isArray(rows) ? rows.length : 0;
          info.rowCounts[table] = count;
          info.totalRows += count;
        }
      } catch (error) {
        info.error = error instanceof Error ? error.message : String(error);
      }

      return info;
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * 导出全部业务表到 `backups/db-<时间戳>.json`。
 *
 * ── 为什么这是「只读」操作 ────────────────────────────────────────────
 * 对数据库只执行 `select * from "<table>"`，连接上带
 * `default_transaction_read_only=on`。写的是**本地文件**，不是库。
 *
 * ── 为什么在 Vercel 上会失败 ──────────────────────────────────────────
 * Vercel 的 Serverless 文件系统除 `/tmp` 外只读。这个函数会如实返回
 * `ok:false` 与 `EROFS` 之类的错误文本，而不是假装成功 —— 页面上
 * 那条红色提示就是「请到本地终端跑 `npm run db:backup`」的依据。
 */
export async function createBackup(databaseUrl: string): Promise<BackupResult> {
  const startedAt = Date.now();
  const dir = backupsDir();
  const file = timestampName();
  const absolutePath = path.join(dir, file);

  const client = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
    connection: {
      application_name: "loxander-ops-backup",
      default_transaction_read_only: true,
      statement_timeout: 60_000,
    },
  });

  try {
    const tables: Record<string, unknown[]> = {};
    const rowCounts: Record<string, number> = {};
    let totalRows = 0;

    for (const table of BACKUP_TABLES) {
      // 表可能还没建（例如只跑了部分迁移）→ 跳过而不是整次失败。
      const exists = await client<{ n: number }[]>`
        select count(*)::int as n
        from information_schema.tables
        where table_schema = 'public' and table_name = ${table}
      `;
      if ((exists[0]?.n ?? 0) === 0) continue;

      // 表名来自上面的常量数组，不含用户输入，但仍按标识符转义后再拼，
      // 免得将来有人把这张表改成动态来源时忘了这层。
      const quoted = `"${table.replace(/"/g, '""')}"`;
      const rows = (await client.unsafe(`select * from ${quoted}`)) as unknown as unknown[];
      tables[table] = rows;
      rowCounts[table] = rows.length;
      totalRows += rows.length;
    }

    const payload = {
      createdAt: new Date().toISOString(),
      schemaVersion: "3",
      source: "ops-console",
      tables,
    };
    const text = JSON.stringify(payload, null, 2);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(absolutePath, text, "utf8");

    return {
      ok: true,
      file,
      bytes: Buffer.byteLength(text, "utf8"),
      totalRows,
      rowCounts,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/** 一次备份比对的结果。 */
export interface BackupVerifyResult {
  ok: boolean;
  /** 逐表比对明细。 */
  tables: { table: string; backupRows: number; currentRows: number | null; same: boolean }[];
  error?: string;
  elapsedMs: number;
}

/**
 * 只读比对：备份文件里的行数 vs 当前库的行数。
 *
 * 只比行数不比内容 —— 与 `scripts/db-backup.mjs` 的 `verify` 同口径。
 * 比内容需要全表拉回内存逐字段 diff，在运维台里跑一次几十秒，
 * 收益（发现「行数一样但内容变了」）远小于成本。
 */
export async function verifyBackup(
  databaseUrl: string,
  file: string,
): Promise<BackupVerifyResult> {
  const startedAt = Date.now();

  // 只允许读 backups/ 下的文件名，挡掉 `../` 之类的路径穿越。
  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    return { ok: false, tables: [], error: "文件名非法。", elapsedMs: Date.now() - startedAt };
  }

  const absolutePath = path.join(backupsDir(), file);
  if (!existsSync(absolutePath)) {
    return {
      ok: false,
      tables: [],
      error: `备份文件不存在：${file}`,
      elapsedMs: Date.now() - startedAt,
    };
  }

  let payload: { tables?: Record<string, unknown[]> };
  try {
    payload = JSON.parse(readFileSync(absolutePath, "utf8")) as typeof payload;
  } catch (error) {
    return {
      ok: false,
      tables: [],
      error: `备份文件解析失败：${error instanceof Error ? error.message : String(error)}`,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const client = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
    connection: {
      application_name: "loxander-ops-backup-verify",
      default_transaction_read_only: true,
      statement_timeout: 30_000,
    },
  });

  try {
    const tables: BackupVerifyResult["tables"] = [];
    let allSame = true;

    for (const table of BACKUP_TABLES) {
      const saved = payload.tables?.[table];
      if (!Array.isArray(saved)) continue;

      const exists = await client<{ n: number }[]>`
        select count(*)::int as n
        from information_schema.tables
        where table_schema = 'public' and table_name = ${table}
      `;
      if ((exists[0]?.n ?? 0) === 0) {
        tables.push({ table, backupRows: saved.length, currentRows: null, same: false });
        allSame = false;
        continue;
      }

      const quoted = `"${table.replace(/"/g, '""')}"`;
      const counted = (await client.unsafe(
        `select count(*)::int as n from ${quoted}`,
      )) as unknown as { n: number }[];
      const currentRows = counted[0]?.n ?? 0;
      const same = currentRows === saved.length;
      if (!same) allSame = false;
      tables.push({ table, backupRows: saved.length, currentRows, same });
    }

    return { ok: allSame, tables, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      tables: [],
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}
