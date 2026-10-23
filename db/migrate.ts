/**
 * 对**真实** Postgres 执行迁移（`db/migrations/*.sql`）。
 *
 * 用法：
 *   node db/migrate.ts --dry-run     # 只列出将执行的迁移文件，不连库（无需 DATABASE_URL）
 *   node db/migrate.ts               # 真连库并执行，需要 DATABASE_URL
 *   node db/migrate.ts --status      # 只读：打印库里已应用的迁移与磁盘上的差集
 *
 * 为什么单独写这个脚本，而不是 `drizzle-kit migrate`：
 *   和 `db/generate-migration.ts` 同一个理由 —— 本机受限 shell 下 drizzle-kit 的 CLI
 *   会 `spawn EPERM`（它内部起子进程）。这里用 drizzle-orm 自带的编程 API
 *   `migrate()`，进程内完成，不派生任何子进程。
 *
 * 迁移记录写在 `drizzle.__drizzle_migrations`（drizzle-orm 的约定表），
 * 因此重复执行是安全的：已应用过的文件会按 `_journal.json` 里的 `when` 跳过。
 *
 * `--status` 只读、不改库：用来在 CI 或上线前确认「磁盘有几份、库里缺几份」。
 */

/* -------------------------------------------------------------------------- */
/* loader 引导                                                                  */
/* -------------------------------------------------------------------------- */

// 本文件只依赖 node 内置与 drizzle-orm，不需要 content-core 的 .ts 后缀 hook。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, '..');
const MIGRATIONS_DIR = join(HERE, 'migrations');
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta', '_journal.json');

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

const USAGE = `
用法：node db/migrate.ts [选项]

选项：
  --dry-run            只列出将执行的迁移文件，不连数据库（无需 DATABASE_URL）
  --status             只读：打印库里已应用 / 尚未应用的迁移
  --verbose            打印每份迁移的文件名与大小
  --help               显示本帮助

环境变量：
  DATABASE_URL         Postgres 连接串；--dry-run 之外必需
                       Neon 控制台：https://console.neon.tech → 项目 → Dashboard → Connection string
                       （必须带 sslmode=require）
`.trim();

interface CliOptions {
  dryRun: boolean;
  status: boolean;
  verbose: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  const options: CliOptions = { dryRun: false, status: false, verbose: false };

  for (const arg of argv) {
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--status':
        options.status = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        return null;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* 迁移文件                                                                    */
/* -------------------------------------------------------------------------- */

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/**
 * 磁盘上的迁移列表（按 `_journal.json` 的 `idx` 升序）。
 *
 * 刻意读 journal 而不是 `readdirSync().sort()`：迁移的应用顺序由 journal 决定，
 * 文件名排序只是「通常一致」。journal 缺失说明迁移目录被破坏，直接报错。
 */
function listMigrationTags(): { tags: string[]; entries: JournalEntry[] } {
  if (!existsSync(JOURNAL_PATH)) {
    throw new Error(`找不到迁移 journal：${JOURNAL_PATH}（db/migrations 目录不完整）`);
  }
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as { entries: JournalEntry[] };
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  return { tags: entries.map((entry) => entry.tag), entries };
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  let options: CliOptions | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    console.error('\n' + USAGE);
    return 2;
  }
  if (options === null) {
    console.log(USAGE);
    return 0;
  }

  const { tags } = listMigrationTags();
  console.log(`[migrate] 迁移目录：${MIGRATIONS_DIR}`);
  console.log(`[migrate] 磁盘上共 ${tags.length} 份迁移`);
  for (const tag of tags) {
    const file = join(MIGRATIONS_DIR, `${tag}.sql`);
    if (!existsSync(file)) {
      console.error(`[migrate] 缺少 ${tag}.sql（journal 里有、磁盘上没有）`);
      return 1;
    }
    if (options.verbose) {
      const size = readFileSync(file).byteLength;
      console.log(`  · ${tag}.sql（${size} B）`);
    } else {
      console.log(`  · ${tag}`);
    }
  }

  if (options.dryRun) {
    console.log('\n[migrate] --dry-run：未连接数据库，未执行任何语句。');
    return 0;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      '\n[migrate] 缺少 DATABASE_URL。\n' +
        '  · 只看计划：node db/migrate.ts --dry-run\n' +
        '  · 看库里已应用到哪：node db/migrate.ts --status（仍需 DATABASE_URL，但只读）\n' +
        '  · 取连接串：Neon 控制台 → 项目 → Dashboard → Connection string（要带 sslmode=require）',
    );
    return 1;
  }

  const { default: postgres } = await import('postgres');
  // max: 1 —— 迁移是一次性任务，连接池没有意义，反而会和 advisory lock 纠缠。
  const client = postgres(url, { max: 1, onnotice: () => {} }) as unknown as PgClient;

  try {
    if (options.status) {
      return await printStatus(client, tags);
    }

    // drizzle 的 migrate() 期望收到它自己的 PostgresJsDatabase，而本文件刻意
    // 只依赖驱动、不 import drizzle 的 schema 类型（迁移只需要 migrationsFolder）。
    // 这里用一次断言桥接：`drizzle(client)` 的运行时形状与 migrate 期望的一致。
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');

    console.log(`\n[migrate] 开始对 ${describeTarget(url)} 执行迁移…`);
    const database = drizzle(client as never);
    await migrate(database as never, { migrationsFolder: MIGRATIONS_DIR });
    console.log('[migrate] 完成。');

    // 迁移后再读一次状态：既验证记录表写进去了，也把最终状态摆给人看。
    return await printStatus(client, tags);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** 连接串脱敏：只留 host/database，绝不把密码打到日志里。 */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, '') || '(默认)';
    return `${parsed.hostname}/${database}`;
  } catch {
    return '(无法解析的连接串)';
  }
}

/**
 * postgres-js 的 client 形状。
 *
 * 不写 `Awaited<ReturnType<typeof import('postgres').default>>` —— `import()` 类型
 * 在 `postgres` 包上的 default 导出形态与运行时不一致（TS2694），所以这里只声明
 * 本文件用到的两个成员：标签模板查询与 `end()`。
 */
interface PgClient {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<T[]>;
  end(options?: { timeout?: number }): Promise<void>;
  /** drizzle-orm 的 postgres-js 适配器只认驱动的 `options` 元信息，这里如实标成可选。 */
  options?: unknown;
}

/**
 * 打印「磁盘上 / 库里已应用」的迁移差集。
 *
 * 记录表是 drizzle 的约定表 `drizzle.__drizzle_migrations`；在它没被创建时
 * （全新库、一次迁移都没跑过）应当显示「全部未应用」，而不是当成错误。
 */
async function printStatus(client: PgClient, tags: readonly string[]): Promise<number> {
  const { entries } = listMigrationTags();

  const tableExists = await client<{ exists: boolean }>`
    select exists (
      select 1 from information_schema.schemata where schema_name = 'drizzle'
    ) as exists
  `;
  if (!tableExists[0]?.exists) {
    console.log('\n[migrate] 库里还没有 drizzle schema → 全部迁移未应用。');
    console.log(`[migrate] 待应用 ${tags.length} 份：${tags.join(', ')}`);
    return 0;
  }

  const applied = await client<{ hash: string; created_at: string }>`
    select hash, created_at from drizzle.__drizzle_migrations order by created_at
  `;
  const appliedCount = applied.length;

  console.log('\n[migrate] 迁移状态');
  console.log(`  磁盘 ${tags.length} 份 / 库里已应用 ${appliedCount} 份`);
  for (const entry of entries) {
    const state = entry.idx < appliedCount ? '✅ 已应用' : '⬜ 待应用';
    console.log(`  ${state}  ${String(entry.idx).padStart(4, '0')} ${entry.tag}`);
  }
  if (appliedCount > tags.length) {
    console.log(
      `  ⚠️ 库里记录的迁移数（${appliedCount}）多于磁盘（${tags.length}）：` +
        '可能连到了别的分支，或本地删掉了迁移文件。',
    );
    return 1;
  }
  if (appliedCount < tags.length) {
    console.log(`\n[migrate] 还有 ${tags.length - appliedCount} 份待应用。`);
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('\n[migrate] 失败：', error);
    process.exitCode = 1;
  });
