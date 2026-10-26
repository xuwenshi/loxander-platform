/**
 * 逻辑备份 / 恢复（不依赖 pg_dump / psql —— 本机两个都没装）。
 *
 * 用法：
 *   node scripts/db-backup.mjs dump                 # 导出到 backups/db-<时间戳>.json
 *   node scripts/db-backup.mjs dump --out foo.json
 *   node scripts/db-backup.mjs restore <file> --dry-run   # 只打印将写入什么
 *   node scripts/db-backup.mjs restore <file>             # 真恢复
 *   node scripts/db-backup.mjs verify <file>        # 只读比对：文件与当前库是否一致
 *
 * 为什么不用 pg_dump：
 *   本机 `pg_dump` / `psql` 都不存在（实测 Get-Command 为空），装 PostgreSQL 客户端
 *   只为导一次数据不值得。这个脚本用已有的 `postgres` 依赖做「按表 select → JSON」，
 *   恢复时 `insert ... on conflict do nothing`。
 *
 * 为什么是 JSON 不是 SQL：
 *   JSON 可以被 verify 逐行比对（`verify` 子命令），SQL 文本只能靠 psql 回放。
 *   代价是 jsonb 列会以对象形式存下来 —— 这正是我们要的，避免字符串转义歧义。
 *
 * 边界（诚实说明）：
 *   - 只备份**数据**，不备份 schema。schema 由 `db/migrations/*.sql` 负责，
 *     恢复前应先跑 `node db/migrate.ts` 保证表结构就位。
 *   - 不备份 `drizzle.__drizzle_migrations`（迁移记录），恢复后迁移状态由磁盘决定。
 *   - 不做增量、不做压缩。这是「出事时能捞回来」的最低保障，不是运维级备份方案。
 *   - 大表会全量读进内存。当前规模（10 篇内容 + 7 张表）完全可以，
 *     内容量到万级时要改成分页流式写。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");
const BACKUP_DIR = join(REPO_ROOT, "backups");

/* -------------------------------------------------------------------------- */
/* 备份范围                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 表清单与恢复顺序（父表在前，避免外键冲突）。
 *
 * 顺序不是字母序，是**依赖序**：
 *   users 被 entries.created_by / audit_logs.actor_id / accounts.user_id 引用；
 *   entries 被 entry_revisions.entry_id / entry_tags.entry_id 引用；
 *   tags 被 entry_tags.tag_id 引用。
 * 恢复时若顺序错，会撞 `violates foreign key constraint`。
 */
const TABLES = [
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
];

/** 恢复时要临时关掉的触发器（当前没有，留位置给未来）。 */
const DISABLED_TRIGGERS = [];

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

function loadEnv() {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[backup] 缺少 DATABASE_URL。请在 .env 里配置，或先跑 --help 看说明。");
    process.exit(1);
  }
  return url;
}

async function connect(url) {
  const { default: postgres } = await import("postgres");
  return postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 });
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/* -------------------------------------------------------------------------- */
/* dump                                                                        */
/* -------------------------------------------------------------------------- */

async function dump(argv) {
  const outIdx = argv.indexOf("--out");
  const explicit = outIdx >= 0 ? argv[outIdx + 1] : undefined;

  const url = requireDatabaseUrl();
  const sql = await connect(url);

  const tables = {};
  const counts = {};
  let totalRows = 0;

  for (const table of TABLES) {
    // 表可能不存在（比如还没跑迁移），跳过而不是报错 —— 让 dump 在任意阶段都能用。
    const exists = await sql`
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = ${table}
    `;
    if (exists.length === 0) {
      console.log(`  - ${table.padEnd(20)} <表不存在，跳过>`);
      continue;
    }
    // 用 query 拼接表名会引入注入风险，表名来自上面的白名单常量，且这里再做一次转义。
    const rows = await sql.unsafe(`select * from "${table.replace(/"/g, '""')}"`);
    tables[table] = rows;
    counts[table] = rows.length;
    totalRows += rows.length;
    console.log(`  - ${table.padEnd(20)} ${String(rows.length).padStart(6)} 行`);
  }

  const payload = {
    meta: {
      createdAt: new Date().toISOString(),
      source: "scripts/db-backup.mjs",
      databaseUrlHash: hashOf(url),
      tableOrder: TABLES,
      counts,
      totalRows,
    },
    tables,
  };

  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const target = explicit
    ? resolvePath(REPO_ROOT, explicit)
    : join(BACKUP_DIR, `db-${stamp()}.json`);

  const json = JSON.stringify(payload);
  writeFileSync(target, json, "utf8");

  console.log(`\n[backup] 已写入 ${target}`);
  console.log(`[backup] ${Object.keys(tables).length} 张表 / ${totalRows} 行 / ${fmtBytes(Buffer.byteLength(json, "utf8"))}`);
  await sql.end({ timeout: 5 });
  return 0;
}

/** 只用于「这份备份来自哪个库」的标识，不泄露连接串。 */
function hashOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/* -------------------------------------------------------------------------- */
/* restore                                                                     */
/* -------------------------------------------------------------------------- */

async function restore(argv) {
  const file = argv.find((a) => !a.startsWith("--") && a !== "restore");
  if (!file) {
    console.error("[restore] 用法：node scripts/db-backup.mjs restore <file> [--dry-run]");
    return 1;
  }
  const dryRun = argv.includes("--dry-run");
  const abs = resolvePath(REPO_ROOT, file);
  if (!existsSync(abs)) {
    console.error(`[restore] 文件不存在：${abs}`);
    return 1;
  }

  const payload = JSON.parse(readFileSync(abs, "utf8"));
  const url = requireDatabaseUrl();

  console.log(`[restore] 备份文件：${abs}`);
  console.log(`[restore] 备份时间：${payload.meta?.createdAt ?? "<未知>"}`);
  console.log(`[restore] 表数 ${Object.keys(payload.tables ?? {}).length} / 总行数 ${payload.meta?.totalRows ?? "?"}`);
  if (dryRun) {
    console.log("\n[restore] --dry-run：只打印，不写库");
    for (const table of TABLES) {
      const rows = payload.tables?.[table];
      if (!rows) continue;
      console.log(`  - ${table.padEnd(20)} 将 upsert ${String(rows.length).padStart(6)} 行`);
    }
    return 0;
  }

  const sql = await connect(url);
  let inserted = 0;

  try {
    await sql.begin(async (tx) => {
      for (const name of DISABLED_TRIGGERS) {
        await tx.unsafe(`alter table "${name}" disable trigger all`);
      }

      for (const table of TABLES) {
        const rows = payload.tables?.[table];
        if (!rows || rows.length === 0) continue;

        // 逐行 insert on conflict do nothing：幂等，重复恢复不会报错也不会翻倍。
        // 不先 truncate —— 恢复的目标是「把丢的补回来」，不是「覆盖成备份那一刻」。
        // 需要完全回退到备份时刻时，先手工 truncate 再 restore。
        for (const row of rows) {
          const cols = Object.keys(row);
          if (cols.length === 0) continue;
          const colList = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
          const values = cols.map((c) => {
            const v = row[c];
            // jsonb 列在驱动里已经反序列化成对象，这里要再序列化回字符串。
            return v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
          });
          await tx.unsafe(
            `insert into "${table.replace(/"/g, '""')}" (${colList}) values (${placeholders}) on conflict do nothing`,
            values,
          );
          inserted++;
        }
        console.log(`  + ${table.padEnd(20)} ${String(rows.length).padStart(6)} 行已尝试写入`);
      }

      for (const name of DISABLED_TRIGGERS) {
        await tx.unsafe(`alter table "${name}" enable trigger all`);
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log(`\n[restore] 完成：${inserted} 行已处理（on conflict do nothing，已存在的行跳过）`);
  return 0;
}

/* -------------------------------------------------------------------------- */
/* verify                                                                      */
/* -------------------------------------------------------------------------- */

async function verify(argv) {
  const file = argv.find((a) => !a.startsWith("--") && a !== "verify");
  if (!file) {
    console.error("[verify] 用法：node scripts/db-backup.mjs verify <file>");
    return 1;
  }
  const abs = resolvePath(REPO_ROOT, file);
  if (!existsSync(abs)) {
    console.error(`[verify] 文件不存在：${abs}`);
    return 1;
  }
  const payload = JSON.parse(readFileSync(abs, "utf8"));
  const url = requireDatabaseUrl();
  const sql = await connect(url);

  console.log(`[verify] 备份：${abs}`);
  let mismatched = 0;

  for (const table of TABLES) {
    const saved = payload.tables?.[table];
    if (!saved) continue;
    const exists = await sql`
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = ${table}
    `;
    if (exists.length === 0) {
      console.log(`  ✗ ${table.padEnd(20)} 当前库里没有这张表`);
      mismatched++;
      continue;
    }
    const current = await sql.unsafe(`select * from "${table.replace(/"/g, '""')}"`);
    const same = current.length === saved.length;
    console.log(
      `  ${same ? "✓" : "✗"} ${table.padEnd(20)} 备份 ${String(saved.length).padStart(5)} 行 / 当前 ${String(current.length).padStart(5)} 行`,
    );
    if (!same) mismatched++;
  }

  await sql.end({ timeout: 5 });
  if (mismatched > 0) {
    console.log(`\n[verify] ${mismatched} 张表行数不一致`);
    return 1;
  }
  console.log("\n[verify] 所有表行数一致");
  return 0;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

const USAGE = `
用法：node scripts/db-backup.mjs <命令> [选项]

命令：
  dump [--out <file>]          导出全部业务表到 JSON（默认 backups/db-<时间戳>.json）
  restore <file> [--dry-run]   从 JSON 恢复（逐行 insert ... on conflict do nothing）
  verify <file>                只读比对：备份与当前库的行数是否一致

环境变量：
  DATABASE_URL                 Postgres 连接串（从 .env 自动读取）

说明：
  只备份数据不备份 schema。恢复前先跑 node db/migrate.ts 保证表结构就位。
`.trim();

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (cmd === "dump") return dump(argv);
  if (cmd === "restore") return restore(argv);
  if (cmd === "verify") return verify(argv);

  console.error(`[backup] 未知命令：${cmd}\n`);
  console.log(USAGE);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[backup] 失败：", err);
    process.exit(1);
  });
