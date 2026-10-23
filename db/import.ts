/**
 * Markdown → Postgres 幂等导入器。
 *
 * 用法：
 *   node db/import.ts --dry-run      # 不连库，只打印将要写入的行（无需 DATABASE_URL）
 *   node db/import.ts                # 真写库，需要 DATABASE_URL
 *   node db/import.ts --verbose      # 额外打印每行完整 JSON
 *
 * 为什么文件开头有一段「loader 引导」：
 *   本仓库的 `@loxander/content-core` / `@loxander/markdown` 的 `exports` 直接指向
 *   `./src/index.ts`，而这两个包的内部 import 是**无扩展名**的（`from './kinds'`），
 *   Node 原生 ESM 解析会报 ERR_MODULE_NOT_FOUND。vitest / tsx 在本机沙箱下都会
 *   `spawn EPERM`，所以只能自己装一个 resolve hook 补 `.ts` 后缀。
 *   hook 必须在**静态 import 解析之前**装好，因此本文件用「先 registerHooks，
 *   再 top-level await import」的写法，而不是普通 import 语句。
 *   `db/mapping.ts` 反而可以正常写静态 import —— 它是在 hook 生效之后才被加载的。
 *
 * 幂等语义：
 *   以 `(kind, slug)` 唯一键 upsert，重复执行不会产生新行。
 *   **冲突时不改 `version`**：version 是后台编辑的乐观锁，导入不是一次用户编辑，
 *   顺手加 1 会让正在编辑的人保存失败。
 */

/* -------------------------------------------------------------------------- */
/* loader 引导（见文件头注释）                                                  */
/* -------------------------------------------------------------------------- */

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const isRelative =
        specifier.startsWith('.') ||
        specifier.startsWith('/') ||
        specifier.startsWith('file:');
      if (!isRelative) throw error;
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
      const bare = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier;
      const target = resolvePath(dirname(parent), bare);
      for (const ext of ['.ts', '.tsx']) {
        if (existsSync(target + ext)) {
          return { url: pathToFileURL(target + ext).href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
});

/* -------------------------------------------------------------------------- */
/* 引导之后再加载依赖                                                           */
/* -------------------------------------------------------------------------- */

import { readFileSync, readdirSync } from 'node:fs';

const { mapEntry, renderOptionsForKind, DROPPED_FRONTMATTER_FIELDS } = await import('./mapping');
const { renderMarkdown } = await import('@loxander/markdown');
const { ENTRY_KINDS } = await import('@loxander/content-core');

type MappedEntry = import('./mapping').MappedEntry;
type EntryKind = import('@loxander/content-core').EntryKind;
type ValidationIssue = import('@loxander/content-core').ValidationIssue;
/**
 * `writeTagRelations` 用到的 drizzle 句柄类型。
 *
 * 用 `PostgresJsDatabase` 的默认泛型参数（`Record<string, never>` 的 schema）：
 * 该函数内部表对象是**动态 import** 进来的，无法在模块顶层写静态类型，
 * 显式声明 schema 泛型反而会与动态取得的值类型不兼容。
 */
type ImportDb = import('drizzle-orm/postgres-js').PostgresJsDatabase;

/* -------------------------------------------------------------------------- */
/* 配置                                                                        */
/* -------------------------------------------------------------------------- */

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根：db/ 的上一层。 */
const REPO_ROOT = resolvePath(HERE, '..');
/** 站点根：content/ 与 public/ 都在这里。 */
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const DEFAULT_CONTENT_DIR = join(WEB_ROOT, 'content');
const DEFAULT_PUBLIC_DIR = join(WEB_ROOT, 'public');

const USAGE = `
用法：node db/import.ts [选项]

选项：
  --dry-run            只解析并打印，不连数据库（无需 DATABASE_URL）
  --verify             连库只读比对：磁盘内容 vs 库里已有数据，不写库（需要 DATABASE_URL）
  --verbose            打印每一行的完整 JSON
  --content-dir <dir>  覆盖内容目录（默认 apps/web/content）
  --help               显示本帮助

环境变量：
  DATABASE_URL         Neon / Postgres 连接串；--dry-run 之外都需要
`.trim();

/* -------------------------------------------------------------------------- */
/* CLI 解析                                                                    */
/* -------------------------------------------------------------------------- */

interface CliOptions {
  dryRun: boolean;
  verify: boolean;
  verbose: boolean;
  contentDir: string;
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  const options: CliOptions = {
    dryRun: false,
    verify: false,
    verbose: false,
    contentDir: DEFAULT_CONTENT_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--verify':
        options.verify = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--content-dir': {
        const value = argv[index + 1];
        if (!value) throw new Error('--content-dir 需要一个路径参数');
        options.contentDir = resolvePath(process.cwd(), value);
        index += 1;
        break;
      }
      case '--help':
      case '-h':
        return null;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }

  // 两个模式互斥：dry-run 不连库，verify 必须连库，同时给只会让人猜哪个生效。
  if (options.dryRun && options.verify) {
    throw new Error('--dry-run 与 --verify 互斥，请只选一个');
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* 扫描                                                                        */
/* -------------------------------------------------------------------------- */

interface SourceFile {
  kind: EntryKind;
  slug: string;
  file: string;
  raw: string;
}

/** 按 ENTRY_KINDS 顺序列出各分区目录下的 .md（排序与站点侧 `.sort()` 一致）。 */
function listSourceFiles(contentDir: string): SourceFile[] {
  const files: SourceFile[] = [];

  for (const kind of ENTRY_KINDS as readonly EntryKind[]) {
    const dir = join(contentDir, kind);
    if (!existsSync(dir)) continue;

    const names = readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort();

    for (const name of names) {
      const file = join(dir, name);
      files.push({
        kind,
        slug: name.replace(/\.md$/, ''),
        file,
        raw: readFileSync(file, 'utf8'),
      });
    }
  }

  return files;
}

/* -------------------------------------------------------------------------- */
/* 构建待写入行                                                                 */
/* -------------------------------------------------------------------------- */

interface Built {
  rows: MappedEntry[];
  rendered: string[];
  /**
   * 与 `rows` **同下标**的标签数组（顺序即 `entry_tags.tag_order`）。
   *
   * 单独放一个平行数组而不是塞进 `MappedEntry`：`MappedEntry` 的字段集合
   * 必须是 `entries` 表的可写子集（见 `db/mapping.ts` 的 `MappedEntry` 注释），
   * 多一个 `tags` 键会让 drizzle 的 `insert().values()` 直接报「列不存在」。
   */
  tags: string[][];
  errors: { file: string; issues: ValidationIssue[] }[];
  warnings: { file: string; issue: ValidationIssue }[];
  counts: Record<string, number>;
}

async function buildRows(files: readonly SourceFile[]): Promise<Built> {
  // 引用完整性需要「全部 blog slug」——必须在映射前一次性收集，
  // 否则 projects 先于 blog 被处理时会误报 warning。
  const knownBlogSlugs = files.filter((f) => f.kind === 'blog').map((f) => f.slug);

  const built: Built = {
    rows: [],
    rendered: [],
    tags: [],
    errors: [],
    warnings: [],
    counts: {},
  };

  for (const file of files) {
    const mapped = mapEntry(file.kind, file.slug, file.raw, {
      publicDir: DEFAULT_PUBLIC_DIR,
      knownBlogSlugs,
    });

    const label = `${file.kind}/${file.slug}.md`;

    if (!mapped.ok) {
      built.errors.push({ file: label, issues: mapped.issues });
      continue;
    }

    for (const issue of mapped.warnings) {
      built.warnings.push({ file: label, issue });
    }

    // body_html 在**导入时**生成一次并存库，读路径不再渲染。
    // 渲染选项按 kind 走 `renderOptionsForKind`（goals 需要 headingOffset: 2 才能与
    // 站点 apps/web/src/lib/goals.ts:88 逐字节相同），不在本文件另写一套。
    const html = await renderMarkdown(mapped.body, renderOptionsForKind(file.kind));

    built.rows.push(mapped.row);
    built.rendered.push(html);
    // 与 rows 同下标，顺序由 mapEntry 保证（原 frontmatter 顺序 = tag_order）。
    built.tags.push(mapped.tags);
    built.counts[file.kind] = (built.counts[file.kind] ?? 0) + 1;
  }

  return built;
}

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

function describeError(file: string, issues: readonly ValidationIssue[]): string {
  const detail = issues
    .map((issue) => (issue.field ? `${issue.field}: ${issue.message}` : issue.message))
    .join('；');
  return `[content/${file}] frontmatter 校验失败 —— ${detail}`;
}

function printDryRun(built: Built, verbose: boolean): void {
  console.log('\n=== 映射结果 ===');
  for (const kind of ENTRY_KINDS as readonly EntryKind[]) {
    console.log(`  ${kind.padEnd(9)} ${built.counts[kind] ?? 0} 行`);
  }
  console.log(`  合计      ${built.rows.length} 行`);

  if (built.warnings.length > 0) {
    console.log(`\n=== warnings（${built.warnings.length} 条，不阻断）===`);
    for (const { file, issue } of built.warnings) {
      const field = issue.field ? `${issue.field}: ` : '';
      const hint = issue.hint ? `（${issue.hint}）` : '';
      console.log(`  ! content/${file}  ${field}${issue.message}${hint}`);
    }
  } else {
    console.log('\n=== warnings 0 条 ===');
  }

  if (built.errors.length > 0) {
    console.log(`\n=== blocking（${built.errors.length} 个文件被跳过）===`);
    for (const { file, issues } of built.errors) {
      console.log('  ✗ ' + describeError(file, issues));
    }
  } else {
    console.log('=== blocking 0 条 ===');
  }

  console.log('\n=== 逐行预览 ===');
  for (let index = 0; index < built.rows.length; index += 1) {
    const row = built.rows[index];
    const html = built.rendered[index];
    const publishedAt = row.published_at ? row.published_at.toISOString() : '(null)';
    console.log(
      `  ${row.kind.padEnd(9)} ${row.slug.padEnd(34)} ` +
        `status=${row.publish_status.padEnd(9)} ` +
        `featured=${String(row.featured).padEnd(5)} ` +
        `sort=${String(row.sort_order).padEnd(4)} ` +
        `date=${String(row.display_date ?? '(null)').padEnd(12)} ` +
        `published_at=${publishedAt} ` +
        `data=${Object.keys(row.data).join(',')} ` +
        `md=${row.body_md.length}B html=${html.length}B`,
    );

    // 这些字段不进 `entries` 行 —— `tags` 会写到 `tags` + `entry_tags` 两张表
    // （见下方 `writeTagRelations` 与末尾 tagStats 汇总），不是被丢弃。
    const dropped = DROPPED_FRONTMATTER_FIELDS[row.kind];
    if (dropped.length > 0) {
      console.log(`            行内不含（已入关系表）：${dropped.join(', ')}`);
    }

    if (verbose) {
      console.log(
        '            ' +
          JSON.stringify({ ...row, body_md: `…${row.body_md.length}B`, data: row.data }),
      );
    }
  }

  console.log(
    '\n[dry-run] 未连接数据库，以上行未写入。去掉 --dry-run 并设置 DATABASE_URL 后才会真正 upsert。',
  );
}

/* -------------------------------------------------------------------------- */
/* 写标签关系                                                                  */
/* -------------------------------------------------------------------------- */

/** `writeTagRelations` 的写入统计，供 CLI 打印。 */
interface TagWriteStats {
  /** 本次**新建**的标签行数（`tags` 表）。 */
  insertedTags: number;
  /** 本次复用的既有标签行数（不新增行，只建立关联）。 */
  reusedTags: number;
  /** 写入 `entry_tags` 的关联行数。 */
  writtenLinks: number;
}

/**
 * 把 `Built.tags` 写入 `tags` + `entry_tags` 两张表。
 *
 * - `tags` 以 `slug`（= 标签名原文，见 `mapping.ts` 的 `tagSlugOf`）为唯一键，
 *   冲突不更新 —— 标签行只有 slug/name 两个业务字段，且两者恒等，
 *   重复导入没有任何需要修正的地方。
 * - `entry_tags` **先删后插**（按本次导入的 entry_id 集合）。不采用
 *   `onConflictDoUpdate` 的原因：那样只能改已有关联的 `tag_order`，删不掉
 *   「frontmatter 里已经去掉的标签」留下的旧关联，重跑会残留脏数据。
 *   先删后插对「同一 entry 的标签集合」是全量覆盖，语义更接近「同步」。
 *   删除范围限定在本次导入的 entry_id 内，不影响后台新建的内容。
 *
 * 顺序：`built.tags[i]` 的数组下标直接落成 `entry_tags.tag_order`
 * （`buildRows` 保证它与 `rows[i]`、`rendered[i]` 同下标）。
 */
async function writeTagRelations(
  db: ImportDb,
  built: Built,
  entryIdOf: ReadonlyMap<string, string>,
): Promise<TagWriteStats> {
  const { inArray } = await import('drizzle-orm');
  const { tags: tagsTable, entryTags } = await import('./schema');
  const { tagSlugOf } = await import('./mapping');

  const stats: TagWriteStats = { insertedTags: 0, reusedTags: 0, writtenLinks: 0 };

  // 1) 收集去重后的标签（保持首次出现顺序，便于日志可读；落库顺序不影响读回）。
  //    slug 与 name 当前恒等（见 mapping.ts 的 tagSlugOf），仍分开记一份：
  //    将来 tagSlugOf 真的做 slugify 时，这里不用改。
  const nameOfSlug = new Map<string, string>();
  for (const names of built.tags) {
    for (const name of names) {
      const slug = tagSlugOf(name);
      if (!nameOfSlug.has(slug)) nameOfSlug.set(slug, name);
    }
  }
  const slugs = [...nameOfSlug.keys()];
  if (slugs.length === 0) return stats;

  // 2) 先查已存在的 slug，再插缺失的 —— 这样能准确区分「新增」与「复用」。
  const existing = (await db
    .select({ slug: tagsTable.slug })
    .from(tagsTable)
    .where(inArray(tagsTable.slug, slugs))) as { slug: string }[];
  const existingSlugs = new Set(existing.map((row) => row.slug));
  const missingSlugs = slugs.filter((slug) => !existingSlugs.has(slug));

  if (missingSlugs.length > 0) {
    await db
      .insert(tagsTable)
      .values(missingSlugs.map((slug) => ({ slug, name: nameOfSlug.get(slug) ?? slug })))
      // 并发导入时另一个进程可能刚插入同名标签：冲突就跳过，后面统一重查 id。
      .onConflictDoNothing({ target: tagsTable.slug });
  }

  // 3) 重新查一遍，拿到本次涉及的全部 tag_id（含刚插入的与已存在的）。
  const tagRows = (await db
    .select({ id: tagsTable.id, slug: tagsTable.slug })
    .from(tagsTable)
    .where(inArray(tagsTable.slug, slugs))) as { id: number; slug: string }[];
  const tagIdOfSlug = new Map(tagRows.map((row) => [row.slug, row.id]));
  stats.insertedTags = missingSlugs.length;
  stats.reusedTags = existingSlugs.size;

  // 4) 组装 entry_tags 行：顺序即 frontmatter 原序。
  const links: { entry_id: string; tag_id: number; tag_order: number }[] = [];
  built.rows.forEach((row, index) => {
    const entryId = entryIdOf.get(`${row.kind}/${row.slug}`);
    if (!entryId) return; // upsert 一定返回过该行，这里只是防御。
    const names = built.tags[index] ?? [];
    names.forEach((name, order) => {
      const tagId = tagIdOfSlug.get(tagSlugOf(name));
      if (tagId === undefined) return;
      links.push({ entry_id: entryId, tag_id: tagId, tag_order: order });
    });
  });

  // 5) 先删后插（只覆盖本次导入的 entry）。
  const entryIds = [...entryIdOf.values()];
  if (entryIds.length > 0) {
    await db.delete(entryTags).where(inArray(entryTags.entry_id, entryIds));
  }
  // 分块插入：单条 SQL 的 bind 参数有上限，内容量增长后一次全传会超。
  const CHUNK = 500;
  for (let i = 0; i < links.length; i += CHUNK) {
    await db.insert(entryTags).values(links.slice(i, i + CHUNK));
  }
  stats.writtenLinks = links.length;

  return stats;
}

/* -------------------------------------------------------------------------- */
/* 只读比对（--verify）                                                         */
/* -------------------------------------------------------------------------- */

/** `--verify` 的一处差异。 */
interface VerifyDiff {
  kind: string;
  slug: string;
  field: string;
  expected: string;
  actual: string;
}

/** 把 jsonb 归一成稳定的字符串：键排序后再 stringify，避免键序不同被当成差异。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** 时间列的比对口径：统一成 `toISOString()`，null 保持 null。 */
function isoOrNull(value: unknown): string {
  if (value === null || value === undefined) return '(null)';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** `display_date` 在驱动里可能被还原成 Date（date 列），统一成 `YYYY-MM-DD`。 */
function dateOnlyOrNull(value: unknown): string {
  if (value === null || value === undefined) return '(null)';
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return text.slice(0, 10);
}

/**
 * `--verify`：连真实的库、**只读**比对「磁盘上的内容」与「库里已有的数据」。
 *
 * 与 `db/compare.ts` 的分工：
 *   - `compare.ts` 用 PGlite 内存库跑完整导入再比对，验证的是**导入器 + 读路径**，
 *     不需要任何真实数据库，CI 里跑；
 *   - 本函数连开发者/生产真实的 Neon，验证的是**库里现在到底是不是最新内容**，
 *     部署前或改完内容后跑。
 *   两者都保留：一个证明「代码对」，一个证明「数据对」。
 *
 * 只读保证：本函数不执行任何 insert/update/delete，仅 select。
 */
async function verifyAgainstDatabase(built: Built): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      '缺少 DATABASE_URL。--verify 需要连库比对；只想看解析结果请加 --dry-run。',
    );
  }

  const { default: postgres } = await import('postgres');
  const client = postgres(url, { max: 1, onnotice: () => {} });

  try {
    const diffs: VerifyDiff[] = [];

    const dbRows = (await client`
      select kind, slug, title, summary, body_md, body_html, publish_status,
             featured, sort_order, published_at, display_date, data
        from entries
    `) as unknown as Record<string, unknown>[];

    const keyOf = (kind: unknown, slug: unknown) => `${String(kind)}/${String(slug)}`;
    const dbBySlug = new Map(dbRows.map((row) => [keyOf(row.kind, row.slug), row]));
    const diskBySlug = new Map(built.rows.map((row) => [`${row.kind}/${row.slug}`, row]));

    // 1) 数量与集合
    for (const kind of ENTRY_KINDS as readonly EntryKind[]) {
      const diskCount = built.counts[kind] ?? 0;
      const dbCount = dbRows.filter((row) => String(row.kind) === kind).length;
      if (diskCount !== dbCount) {
        diffs.push({
          kind,
          slug: '*',
          field: '行数',
          expected: String(diskCount),
          actual: String(dbCount),
        });
      }
    }
    for (const key of diskBySlug.keys()) {
      if (!dbBySlug.has(key)) {
        const [kind, slug] = key.split('/');
        diffs.push({ kind, slug, field: '(缺失)', expected: '库中有该行', actual: '库里没有' });
      }
    }
    for (const key of dbBySlug.keys()) {
      if (!diskBySlug.has(key)) {
        const [kind, slug] = key.split('/');
        diffs.push({ kind, slug, field: '(多余)', expected: '磁盘上没有该行', actual: '库里多出' });
      }
    }

    // 2) 逐行字段
    const fieldChecks: {
      field: string;
      disk: (row: MappedEntry, index: number) => string;
      db: (row: Record<string, unknown>) => string;
    }[] = [
      { field: 'title', disk: (row) => row.title, db: (row) => String(row.title) },
      { field: 'summary', disk: (row) => row.summary, db: (row) => String(row.summary) },
      { field: 'body_md', disk: (row) => row.body_md, db: (row) => String(row.body_md) },
      { field: 'publish_status', disk: (row) => row.publish_status, db: (row) => String(row.publish_status) },
      { field: 'featured', disk: (row) => String(row.featured), db: (row) => String(row.featured === true) },
      { field: 'sort_order', disk: (row) => String(row.sort_order), db: (row) => String(Number(row.sort_order)) },
      {
        field: 'display_date',
        disk: (row) => row.display_date ?? '(null)',
        db: (row) => dateOnlyOrNull(row.display_date),
      },
      { field: 'data', disk: (row) => canonicalJson(row.data), db: (row) => canonicalJson(row.data) },
      {
        field: 'body_html',
        disk: (_row, index) => built.rendered[index] ?? '',
        db: (row) => String(row.body_html ?? ''),
      },
    ];

    built.rows.forEach((row, index) => {
      const dbRow = dbBySlug.get(`${row.kind}/${row.slug}`);
      if (!dbRow) return; // 已在「缺失」里报过
      for (const check of fieldChecks) {
        const expected = check.disk(row, index);
        const actual = check.db(dbRow);
        if (expected !== actual) {
          diffs.push({
            kind: row.kind,
            slug: row.slug,
            field: check.field,
            expected: `${expected.slice(0, 160)}${expected.length > 160 ? '…' : ''}`,
            actual: `${actual.slice(0, 160)}${actual.length > 160 ? '…' : ''}`,
          });
        }
      }

      // 3) published_at：两类内容的语义不同，**不能统一逐字比对**。
      //    - blog/diary：值来自 frontmatter 的 date（经东八区换算），是内容自身的事实，
      //      重跑导入必须得到同一个值 → 逐字比。
      //    - projects/goals：这两类没有日期字段，published_at 取「首次导入的时刻」
      //      （db/import.ts 的 upsert 用 coalesce 保住旧值，保证幂等）。因此磁盘侧
      //      每次映射都会生成一个新的 new Date()，与库里首次写入的时间天然不同 ——
      //      逐字比会把「正常的幂等」误报成差异（这正是本脚本第一版踩的坑）。
      //      db/compare.ts:913-923 对此的处理是「落在这轮窗口内」，但 --verify 跑在
      //      导入之后的任意时刻，没有窗口可比，所以这里只校验「非空且是合法时间戳」。
      if (row.kind === 'blog' || row.kind === 'diary') {
        const expected = isoOrNull(row.published_at);
        const actual = isoOrNull(dbRow.published_at);
        if (expected !== actual) {
          diffs.push({
            kind: row.kind,
            slug: row.slug,
            field: 'published_at',
            expected,
            actual,
          });
        }
      } else {
        const actual = dbRow.published_at;
        const parsed = actual === null || actual === undefined ? Number.NaN : new Date(String(actual)).getTime();
        if (actual === null || actual === undefined || Number.isNaN(parsed)) {
          diffs.push({
            kind: row.kind,
            slug: row.slug,
            field: 'published_at',
            expected: '首次导入时刻（非空时间戳）',
            actual: String(actual),
          });
        }
      }
    });

    // 3) 标签（集合 + 顺序）
    const tagRows = (await client`
      select et.entry_id, e.kind, e.slug, t.name
        from entry_tags et
        join tags t on t.id = et.tag_id
        join entries e on e.id = et.entry_id
       order by et.entry_id, et.tag_order
    `) as unknown as { kind: string; slug: string; name: string }[];
    const tagsOfEntry = new Map<string, string[]>();
    for (const row of tagRows) {
      const key = keyOf(row.kind, row.slug);
      const list = tagsOfEntry.get(key);
      if (list) list.push(String(row.name));
      else tagsOfEntry.set(key, [String(row.name)]);
    }
    for (const [key, row] of diskBySlug) {
      const expected = built.tags[built.rows.indexOf(row)] ?? [];
      const actual = tagsOfEntry.get(key) ?? [];
      if (expected.join('\u0000') !== actual.join('\u0000')) {
        diffs.push({
          kind: row.kind,
          slug: row.slug,
          field: 'tags',
          expected: JSON.stringify(expected),
          actual: JSON.stringify(actual),
        });
      }
    }

    // 4) 报告
    console.log('\n=== --verify 只读比对结果 ===');
    console.log(`  磁盘 ${built.rows.length} 行 / 库里 ${dbRows.length} 行`);
    for (const kind of ENTRY_KINDS as readonly EntryKind[]) {
      console.log(
        `  ${kind.padEnd(9)} 磁盘 ${String(built.counts[kind] ?? 0).padEnd(3)} ` +
          `库 ${String(dbRows.filter((row) => String(row.kind) === kind).length).padEnd(3)}`,
      );
    }
    if (diffs.length === 0) {
      console.log('  ✅ 字段、标签、行数全部一致，退出码 0。');
      return 0;
    }
    console.log(`  ❌ 发现 ${diffs.length} 处差异：`);
    for (const diff of diffs.slice(0, 50)) {
      console.log(`  · ${diff.kind}/${diff.slug} ${diff.field}`);
      console.log(`      磁盘: ${diff.expected}`);
      console.log(`      库里: ${diff.actual}`);
    }
    if (diffs.length > 50) console.log(`  … 其余 ${diffs.length - 50} 处省略`);
    console.log('\n  提示：差异通常意味着库里不是最新内容，先跑 node db/import.ts 再验。');
    return 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

/* -------------------------------------------------------------------------- */
/* 写库                                                                        */
/* -------------------------------------------------------------------------- */

async function writeToDatabase(built: Built): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      '缺少 DATABASE_URL。只想看解析结果请加 --dry-run（本机没有 Postgres，dry-run 是当前唯一可跑通的模式）。',
    );
  }

  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { sql } = await import('drizzle-orm');
  const { entries } = await import('./schema');

  // max: 1 ——导入是一次性批量任务，不需要连接池。
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client);

  try {
    const values = built.rows.map((row, index) => ({
      ...row,
      body_html: built.rendered[index],
    }));

    // returning 只取 (kind, slug, id)：后面写 entry_tags 要靠 id，
    // 而冲突时 RETURNING 拿到的是**库里那一行**的 id（不是新插入的），正是我们要的。
    const upserted = (await db
      .insert(entries)
      .values(values)
      .onConflictDoUpdate({
        target: [entries.kind, entries.slug],
        set: {
          title: sql`excluded.title`,
          summary: sql`excluded.summary`,
          body_md: sql`excluded.body_md`,
          body_html: sql`excluded.body_html`,
          publish_status: sql`excluded.publish_status`,
          featured: sql`excluded.featured`,
          sort_order: sql`excluded.sort_order`,
          // coalesce：库里已有该行则**保留原 published_at**，只有新行才采用传入值。
          // 原因：projects/goals 没有日期字段，published_at 取导入时刻；若直接写入
          // excluded.published_at，每次重跑都会刷新这几行的时间戳，打脏
          // entries_public_idx 与 P3 的缓存，收益为零。
          // blog/diary 的 published_at 来自 frontmatter date（本就幂等），一并走 coalesce
          // 无副作用，好处是四类共用一条规则、不必按 kind 分支。
          published_at: sql`coalesce(${entries.published_at}, excluded.published_at)`,
          display_date: sql`excluded.display_date`,
          data: sql`excluded.data`,
          updated_at: sql`now()`,
          // version 有意不写：见文件头注释。
        },
      })
      .returning({ kind: entries.kind, slug: entries.slug, id: entries.id })) as {
      kind: string;
      slug: string;
      id: string;
    }[];

    console.log(`\n[import] 已 upsert ${values.length} 行。`);

    const entryIdOf = new Map(upserted.map((row) => [`${row.kind}/${row.slug}`, row.id]));
    const tagStats = await writeTagRelations(db, built, entryIdOf);
    console.log(
      `[import] tags 表新增 ${tagStats.insertedTags} 个新标签（复用 ${tagStats.reusedTags} 个已有标签），` +
        `entry_tags 写入 ${tagStats.writtenLinks} 条关联。`,
    );

    // 库里存在、但磁盘上已删除的行：只报告，不自动删（避免误删后台新建的内容）。
    const rows = (await db.select({ kind: entries.kind, slug: entries.slug }).from(entries)) as {
      kind: string;
      slug: string;
    }[];
    const onDisk = new Set(built.rows.map((row) => `${row.kind}/${row.slug}`));
    const stale = rows.filter((row) => !onDisk.has(`${row.kind}/${row.slug}`));
    if (stale.length > 0) {
      console.log(`[import] 库中有 ${stale.length} 行在磁盘上已不存在（未删除）：`);
      for (const row of stale) console.log(`  - ${row.kind}/${row.slug}`);
    }
    console.log(`[import] entries 表当前共 ${rows.length} 行。`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
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

  const files = listSourceFiles(options.contentDir);
  console.log(`[import] 内容目录：${options.contentDir}`);
  console.log(`[import] 发现 ${files.length} 个 .md 文件`);
  if (files.length === 0) {
    console.error('[import] 没有找到任何 .md，检查 --content-dir。');
    return 1;
  }

  const built = await buildRows(files);

  if (options.dryRun) {
    printDryRun(built, options.verbose);
  } else if (options.verify) {
    // 比对前也要把 blocking 摆出来：跳过了 3 个文件还报「一致」是假绿。
    if (built.errors.length > 0) {
      console.log(`\n=== blocking（${built.errors.length} 个文件被跳过）===`);
      for (const { file, issues } of built.errors) {
        console.log('  ✗ ' + describeError(file, issues));
      }
    }
    console.log(`[verify] 待比对 ${built.rows.length} 行（只读，不写库）`);
    if (!process.env.DATABASE_URL) {
      // 这条是「配置缺失」，不是崩溃，所以不用抛异常把栈打出来。
      console.error(
        '[verify] 缺少 DATABASE_URL。取连接串：Neon 控制台 → 项目 → Dashboard → Connection string（要带 sslmode=require）。',
      );
      return 1;
    }
    const verifyCode = await verifyAgainstDatabase(built);
    if (verifyCode !== 0) return verifyCode;
  } else {
    // 真写库前也要把校验结果摆出来，避免「跳过了 3 个文件还静默成功」。
    if (built.errors.length > 0) {
      console.log(`\n=== blocking（${built.errors.length} 个文件被跳过）===`);
      for (const { file, issues } of built.errors) {
        console.log('  ✗ ' + describeError(file, issues));
      }
    }
    console.log(`[import] 待写入 ${built.rows.length} 行`);
    await writeToDatabase(built);
  }

  // 有 blocking 就非 0 退出，CI 能拦住。
  if (built.errors.length > 0) {
    console.error(`\n[import] 有 ${built.errors.length} 个文件校验失败，已跳过。`);
    return 1;
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('[import] 失败：', error);
    process.exitCode = 1;
  });
