/**
 * markdown 源 vs db 源 —— 逐字段比对（P2 验收闸门）。
 *
 * 用法：
 *   node db/compare.ts              # 人类可读差异报告；退出码 0=无差异，1=有差异
 *   node db/compare.ts --verbose    # 额外打印文本字段的期望值 / 实际值片段
 *
 * ── 两路数据从哪来 ────────────────────────────────────────────────────
 * markdown 路：**直接调用站点自己的 lib**（`apps/web/src/lib/{posts,projects,diary,goals}.ts`），
 *   拿到的就是站点今天真实返回的对象 —— 含排序、渲染产物、TOC。
 *   本文件刻意不在 markdown 侧重写任何解析/排序/渲染逻辑：
 *   一旦重写就成了「第三套实现」，两边都跟它比，比对立刻失去参照意义。
 *   （唯一额外做的事：为了拿到 `body_md`，把原文再读一遍并 `matter()` 一次，
 *     再 `content.trim()` —— 与 `db/mapping.ts` 的 `body.trim()` 归一方式一致。）
 *
 * db 路：`db/mapping.ts` 的 `mapEntry()` → 按 `db/import.ts` 的方式、用
 *   `mapping.ts` 导出的 `renderOptionsForKind(kind)` 渲染 `body_html`
 *   → 灌进 PGlite 内存库（跑真迁移 `db/migrations/0000_init.sql`）→ 再 select 读出来。
 *   也就是「导入 → 落库 → 读出」的完整闭环，而不是拿内存里的中间值糊过去。
 *
 *   渲染选项**必须**来自 `renderOptionsForKind`，不能在本文件另写一份常量：
 *   那是「导入侧到底怎么渲染」的唯一真源，复制一份就会与 import.ts 漂移。
 *
 * ── 为什么用 PGlite ──────────────────────────────────────────────────
 * 本机没有 Postgres，且沙箱不允许起外部进程（`node --test` 都因 spawn 被拒）。
 * PGlite 是真实的 PostgreSQL 18.6 wasm 构建，迁移、CHECK、唯一索引、jsonb、
 * timestamptz、date 的行为全部是真的 —— 唯一差别是它不经过网络。
 *
 * ── 为什么文件开头有一段「loader 引导」────────────────────────────────
 * 与 `db/import.ts` 完全相同的原因：本仓库共享包的 `exports` 直接指向 `./src/index.ts`，
 * 而包内部 import 是无扩展名的（`from './kinds'`），Node 原生 ESM 解析会
 * `ERR_MODULE_NOT_FOUND`；vitest / tsx 在本机都会 spawn EPERM。
 * hook 必须在静态 import 解析之前装好，所以先 `registerHooks()`，再 top-level await import。
 * 静态 import 只保留 `node:` 内建模块。
 */

/* -------------------------------------------------------------------------- */
/* loader 引导                                                                 */
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
import process from 'node:process';

import matter from 'gray-matter';

import type { EntryKind, ValidationIssue } from '@loxander/content-core';

/* -------------------------------------------------------------------------- */
/* 路径                                                                        */
/* -------------------------------------------------------------------------- */

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根：db/ 的上一层。 */
const REPO_ROOT = resolvePath(HERE, '..');
/** 站点根：content/ 与 public/ 都在这里。 */
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const CONTENT_DIR = join(WEB_ROOT, 'content');
const PUBLIC_DIR = join(WEB_ROOT, 'public');

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

/** 站点侧四种元信息类型的最小结构（只声明比对用得到的字段）。 */
interface SiteMeta {
  slug: string;
  [key: string]: unknown;
}

/** 归一化之后「可对比的一条内容」。两路都要能映射成它。 */
interface Comparable {
  kind: EntryKind;
  slug: string;
  title: string;
  summary: string;
  /** 正文字面量（已 trim，与 mapping.ts 一致）。 */
  body_md: string;
  /** 渲染产物。 */
  body_html: string;
  /** TOC 条目，`id|text|level` 三字段。 */
  headings: string[];
  /** ISO 时间串；null 表示该条没有日期。 */
  published_at: string | null;
  /** `YYYY-MM-DD`；null 表示该条只有 `data.period`。 */
  display_date: string | null;
  data: Record<string, unknown>;
  /**
   * 标签名，**顺序即 frontmatter 原序**（库里由 `entry_tags.tag_order` 保序）。
   *
   * blog / diary 有；projects / goals 恒为 `[]`（它们的站点类型没有 tags 字段）。
   */
  tags: string[];
  featured: boolean;
  sort_order: number;
  publish_status: string;
}

/** 一条差异。 */
interface Finding {
  dim: string;
  kind: string;
  slug: string;
  message: string;
}

/** `SourceFile` 与 `db/import.ts:143` 一致。 */
interface SourceFile {
  kind: EntryKind;
  slug: string;
  file: string;
  raw: string;
}

/** PGlite 的最小结构（只用到 query）。 */
interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

const VERBOSE = process.argv.includes('--verbose');

/** 逐字符找第一个差异位置；完全相同返回 -1。 */
function firstDiffIndex(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : len;
}

/** 取差异位置附近的一段，便于肉眼定位。 */
function excerpt(text: string, index: number, radius = 40): string {
  if (index < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return `${head}${text.slice(start, end).replace(/\n/g, '\\n')}${tail}`;
}

/** 稳定序列化：对象键排序，用于 jsonb 的等值判断。 */
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

/** PGlite 的 `date` 列可能回成 `Date`（wasm 侧的 DateStyle），统一输出 `YYYY-MM-DD`。 */
function toDisplayDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return text.length > 10 ? text.slice(0, 10) : text;
}

/** PGlite 的 `timestamptz` 列回成 `Date`，统一输出 ISO 串。 */
function toIsoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

/** TOC 归一成可比较的字符串数组。 */
function normalizeHeadings(headings: readonly unknown[]): string[] {
  return headings.map((item) => {
    const record = item as { id?: unknown; text?: unknown; level?: unknown };
    return `${String(record.id)}|${String(record.text)}|${String(record.level)}`;
  });
}

/* -------------------------------------------------------------------------- */
/* 报告器                                                                      */
/* -------------------------------------------------------------------------- */

class Report {
  readonly lines: string[] = [];
  readonly diffs: Finding[] = [];
  readonly gaps: string[] = [];
  checks = 0;

  title(text: string): void {
    this.lines.push('');
    this.lines.push('═'.repeat(78));
    this.lines.push(`  ${text}`);
    this.lines.push('═'.repeat(78));
  }

  section(text: string): void {
    this.lines.push('');
    this.lines.push(`── ${text} ${'─'.repeat(Math.max(0, 70 - text.length))}`);
  }

  info(text: string): void {
    this.lines.push(`   ${text}`);
  }

  /** 记一次通过的检查。 */
  pass(text: string): void {
    this.checks += 1;
    this.lines.push(`   ✅ ${text}`);
  }

  /** 记一次失败，同时计入差异清单。 */
  fail(dim: string, kind: string, slug: string, message: string, detail: readonly string[] = []): void {
    this.checks += 1;
    this.diffs.push({ dim, kind, slug, message });
    this.lines.push(`   ❌ [${dim}] ${kind}/${slug}：${message}`);
    for (const line of detail) this.lines.push(`        ${line}`);
  }

  gap(text: string): void {
    this.gaps.push(text);
  }

  render(): string {
    return this.lines.join('\n');
  }
}

/* -------------------------------------------------------------------------- */
/* markdown 路                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 扫描内容目录（顺序与 `db/import.ts` 的 `listSourceFiles` 一致：ENTRY_KINDS 顺序 + 文件名 sort）。
 *
 * `kinds` 必须由调用方传入 `content-core` 的 `ENTRY_KINDS`，不在本文件另抄一份数组：
 * 这个顺序决定插入顺序，而 Node 的 sort 是稳定的 —— 一旦与 `ENTRY_KINDS` 不一致，
 * 「同日期并列项」的两路相对顺序就会变，维度 8/9 会以看起来毫不相关的方式红掉。
 */
function listSourceFiles(kinds: readonly EntryKind[]): SourceFile[] {
  const files: SourceFile[] = [];

  for (const kind of kinds) {
    const dir = join(CONTENT_DIR, kind);
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

/** 把 frontmatter 里的实际值按 `mapping.ts` 的 `putIfPresent` 语义塞进 data。 */
function putIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && value === '') return;
  target[key] = value;
}

interface MarkdownSide {
  /** 站点真实返回的顺序（各类 lib 自己排好的）。 */
  ordered: Record<string, Comparable[]>;
  /** 四类合计的原文（用于 db 侧复用，避免重复读盘）。 */
  files: SourceFile[];
}

async function readMarkdownSide(
  kinds: readonly EntryKind[],
  defaultSortOrder: number,
): Promise<MarkdownSide> {
  const files = listSourceFiles(kinds);
  const bodyOf = new Map<string, string>();
  for (const file of files) {
    const { content } = matter(file.raw);
    bodyOf.set(`${file.kind}/${file.slug}`, content.trim());
  }

  // 站点 lib 用 `process.cwd()` 拼目录，所以必须先切到 apps/web 再 import。
  process.chdir(WEB_ROOT);

  const libUrl = (name: string) =>
    pathToFileURL(join(WEB_ROOT, 'src', 'lib', `${name}.ts`)).href;

  const postsLib = (await import(libUrl('posts'))) as {
    getAllPosts(): SiteMeta[];
    getPost(slug: string): Promise<{ html: string; headings: unknown[] } | null>;
  };
  const projectsLib = (await import(libUrl('projects'))) as {
    getAllProjects(): SiteMeta[];
    getProject(slug: string): Promise<{ html: string; headings: unknown[] } | null>;
  };
  const diaryLib = (await import(libUrl('diary'))) as {
    getAllDiaryEntries(): SiteMeta[];
    getDiaryEntry(slug: string): Promise<{ html: string; headings: unknown[] } | null>;
  };
  const goalsLib = (await import(libUrl('goals'))) as {
    getAllGoals(): Promise<Array<SiteMeta & { html: string; headings: unknown[] }>>;
  };

  /* ------------------------------ blog ------------------------------ */
  const blog: Comparable[] = [];
  for (const meta of postsLib.getAllPosts()) {
    const full = await postsLib.getPost(meta.slug);
    if (!full) throw new Error(`站点侧取不到文章：${meta.slug}（getAllPosts 与 getPost 不一致）`);
    const data: Record<string, unknown> = { category: meta.category };
    putIfPresent(data, 'cover', meta.cover);
    putIfPresent(data, 'coverWidth', meta.coverWidth);
    putIfPresent(data, 'coverHeight', meta.coverHeight);
    blog.push({
      kind: 'blog',
      slug: meta.slug,
      title: meta.title as string,
      summary: meta.description as string,
      body_md: bodyOf.get(`blog/${meta.slug}`) ?? '',
      body_html: full.html,
      headings: normalizeHeadings(full.headings),
      published_at: null, // 站点对象没有该字段，单独在「时区」维度验证
      display_date: meta.date as string,
      data,
      // 站点侧 `PostMeta.tags` 就是 frontmatter 原序；库里由 `entry_tags.tag_order` 保序。
      tags: (meta.tags as string[] | undefined) ?? [],
      featured: false,
      // 固定排序值来自 `mapping.ts` 的 `DEFAULT_SORT_ORDER`（blog 没有 order 字段）。
      sort_order: defaultSortOrder,
      publish_status: meta.draft === true ? 'draft' : 'published',
    });
  }

  /* ---------------------------- projects ---------------------------- */
  const projects: Comparable[] = [];
  for (const meta of projectsLib.getAllProjects()) {
    const full = await projectsLib.getProject(meta.slug);
    if (!full) throw new Error(`站点侧取不到项目：${meta.slug}`);
    const data: Record<string, unknown> = {
      techStack: meta.techStack,
      status: meta.status,
    };
    putIfPresent(data, 'period', meta.period);
    putIfPresent(data, 'role', meta.role);
    putIfPresent(data, 'github', meta.github);
    putIfPresent(data, 'demo', meta.demo);
    putIfPresent(data, 'article', meta.article);
    projects.push({
      kind: 'projects',
      slug: meta.slug,
      title: meta.name as string,
      summary: meta.description as string,
      body_md: bodyOf.get(`projects/${meta.slug}`) ?? '',
      body_html: full.html,
      headings: normalizeHeadings(full.headings),
      published_at: null,
      display_date: null,
      data,
      tags: [], // `ProjectMeta` 没有 tags 字段
      featured: meta.featured === true,
      sort_order: meta.order as number,
      // 刻意不复用 mapping.ts 的常量：这一行表达的是**外部事实** ——
      // content-core 的 projects schema 至今没有 draft 字段，所以项目恒为已发布。
      // 将来 P4 给 projects 加 draft 时，这行本来就该跟着改；
      // 若改成 import 一个常量，反而会把「schema 没有 draft」这个事实藏起来。
      publish_status: 'published',
    });
  }

  /* ----------------------------- diary ------------------------------ */
  const diary: Comparable[] = [];
  for (const meta of diaryLib.getAllDiaryEntries()) {
    const full = await diaryLib.getDiaryEntry(meta.slug);
    if (!full) throw new Error(`站点侧取不到日记：${meta.slug}`);
    // 口径与 `db/mapping.ts` 的 diary 分支一致：date 已提升为 `display_date` 列，
    // data 里只留 `{ mood? }`（无 mood 时为空对象），不再重复存 date。
    const data: Record<string, unknown> = {};
    putIfPresent(data, 'mood', meta.mood);
    diary.push({
      kind: 'diary',
      slug: meta.slug,
      title: meta.title as string,
      summary: meta.summary as string,
      body_md: bodyOf.get(`diary/${meta.slug}`) ?? '',
      body_html: full.html,
      headings: normalizeHeadings(full.headings),
      published_at: null,
      display_date: meta.date as string,
      data,
      // `DiaryMeta.tags` 同样来自 frontmatter 原序。
      tags: (meta.tags as string[] | undefined) ?? [],
      featured: false,
      // 同 blog：固定排序值来自 `mapping.ts` 的 `DEFAULT_SORT_ORDER`。
      sort_order: defaultSortOrder,
      publish_status: meta.draft === true ? 'draft' : 'published',
    });
  }

  /* ----------------------------- goals ------------------------------ */
  const goals: Comparable[] = [];
  for (const goal of await goalsLib.getAllGoals()) {
    const data: Record<string, unknown> = {
      horizon: goal.horizon,
      status: goal.status,
      progress: goal.progress,
      milestones: goal.milestones,
    };
    putIfPresent(data, 'period', goal.period);
    goals.push({
      kind: 'goals',
      slug: goal.slug,
      // `Goal` 的 title/order 在 content-core 里是 `unknown`（zod 的 transform 结果），
      // 站点侧靠 Zod 校验保证形态；这里显式收窄，避免 unknown 直接进 Comparable。
      title: String(goal.title),
      summary: '', // goals 没有摘要字段，列默认 ''
      body_md: bodyOf.get(`goals/${goal.slug}`) ?? '',
      body_html: goal.html,
      headings: normalizeHeadings(goal.headings),
      published_at: null,
      display_date: null,
      data,
      tags: [], // `Goal` 没有 tags 字段
      featured: false,
      sort_order: Number(goal.order),
      // 同 projects：表达「goals schema 无 draft 字段」这一外部事实，而非 mapping.ts 的内部常量。
      publish_status: 'published',
    });
  }

  return { ordered: { blog, projects, diary, goals }, files };
}

/* -------------------------------------------------------------------------- */
/* db 路                                                                       */
/* -------------------------------------------------------------------------- */

/** 插入 entries 用到的列，顺序固定；cast 用于让 PGlite 正确解释字符串参数。 */
const ENTRY_INSERT_COLUMNS: ReadonlyArray<{ name: string; cast: string }> = [
  { name: 'kind', cast: '' },
  { name: 'slug', cast: '' },
  { name: 'title', cast: '' },
  { name: 'summary', cast: '' },
  { name: 'body_md', cast: '' },
  { name: 'body_html', cast: '' },
  { name: 'publish_status', cast: '' },
  { name: 'featured', cast: '' },
  { name: 'sort_order', cast: '' },
  { name: 'published_at', cast: '::timestamptz' },
  { name: 'display_date', cast: '::date' },
  { name: 'data', cast: '::jsonb' },
  { name: 'version', cast: '' },
];

/** 一条待写入的 entries 行（`MappedEntry` + 渲染好的 body_html + 标签）。 */
interface DbRow {
  kind: EntryKind;
  slug: string;
  title: string;
  summary: string;
  body_md: string;
  body_html: string;
  publish_status: string;
  featured: boolean;
  sort_order: number;
  published_at: Date | null;
  display_date: string | null;
  data: Record<string, unknown>;
  version: number;
  /**
   * 标签名（frontmatter 原序，下标即 `entry_tags.tag_order`）。
   *
   * 不写进 `entries` 表 —— 由 `writeTagRelations()` 分别写入 `tags` / `entry_tags`。
   */
  tags: string[];
}

/** 按列名取参数值，并转成 PGlite 能正确绑定的形态。 */
function toInsertParams(row: DbRow): unknown[] {
  const byName: Record<string, unknown> = {
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body_md: row.body_md,
    body_html: row.body_html,
    publish_status: row.publish_status,
    featured: row.featured,
    sort_order: row.sort_order,
    // timestamptz：Date 直接绑在 wasm 侧容易丢精度，统一走 ISO 串 + cast
    published_at: row.published_at ? row.published_at.toISOString() : null,
    display_date: row.display_date,
    // jsonb：字符串 + ::jsonb，避免依赖驱动的对象序列化差异
    data: JSON.stringify(row.data ?? {}),
    version: row.version,
  };
  return ENTRY_INSERT_COLUMNS.map((column) => byName[column.name]);
}

async function insertRow(db: Queryable, row: DbRow): Promise<void> {
  const columns = ENTRY_INSERT_COLUMNS.map((column) => `"${column.name}"`).join(', ');
  const placeholders = ENTRY_INSERT_COLUMNS.map(
    (column, index) => `$${index + 1}${column.cast}`,
  ).join(', ');
  await db.query(`insert into entries (${columns}) values (${placeholders})`, toInsertParams(row));
}

/**
 * 把 `DbRow.tags` 写进 `tags` + `entry_tags`（与 `db/import.ts` 的
 * `writeTagRelations` 同语义：标签表按 slug 幂等、关系表按 entry 先删后插）。
 *
 * 比对脚本之所以要自己写一遍而不是复用导入器：导入器连的是真 Postgres
 * （`postgres-js` + drizzle），这里的 `db` 是 PGlite 的 `Queryable` 包装，
 * 驱动类型不同。逻辑刻意保持等价，任一侧改了都要同步改。
 */
async function writeTagRelations(db: Queryable, rows: readonly DbRow[]): Promise<number> {
  const nameOfSlug = new Map<string, string>();
  for (const row of rows) {
    for (const name of row.tags) nameOfSlug.set(name, name);
  }
  if (nameOfSlug.size === 0) return 0;

  // 标签主表：slug 唯一键，冲突不更新（slug/name 恒等，见 mapping.ts 的 tagSlugOf）。
  for (const [slug, name] of nameOfSlug) {
    await db.query(
      `insert into tags (slug, name) values ($1, $2) on conflict (slug) do nothing`,
      [slug, name],
    );
  }

  const tagIdOfSlug = new Map<string, number>();
  const tagResult = await db.query<{ id: number; slug: string }>(`select id, slug from tags`);
  for (const raw of tagResult.rows) tagIdOfSlug.set(String(raw.slug), Number(raw.id));

  const entryIdOf = new Map<string, string>();
  const entryResult = await db.query<{ id: string; kind: string; slug: string }>(
    `select id, kind, slug from entries`,
  );
  for (const raw of entryResult.rows) {
    entryIdOf.set(`${String(raw.kind)}/${String(raw.slug)}`, String(raw.id));
  }

  let written = 0;
  for (const row of rows) {
    const entryId = entryIdOf.get(`${row.kind}/${row.slug}`);
    if (entryId === undefined) throw new Error(`写标签时找不到 ${row.kind}/${row.slug} 的 entry id`);
    if (row.tags.length === 0) continue;

    // 先删后插：能清掉「frontmatter 里已去掉的标签」残留的旧关联。
    await db.query(`delete from entry_tags where entry_id = $1::uuid`, [entryId]);
    for (const [order, name] of row.tags.entries()) {
      const tagId = tagIdOfSlug.get(name);
      if (tagId === undefined) throw new Error(`写标签时找不到标签 ${name} 的 id`);
      await db.query(
        `insert into entry_tags (entry_id, tag_id, tag_order) values ($1::uuid, $2, $3)`,
        [entryId, tagId, order],
      );
      written += 1;
    }
  }
  return written;
}

/** 从库里读回四类内容并归一化（含标签关系）。 */
async function readDbSide(
  db: Queryable,
  rows: readonly DbRow[],
): Promise<Record<string, Comparable[]>> {
  const result = await db.query<Record<string, unknown>>(
    `select id, kind, slug, title, summary, body_md, body_html, publish_status,
            featured, sort_order, published_at, display_date, data
       from entries`,
  );

  // 标签一次查完再分组：`entry_tags` 是关系表，逐行查会变成 31 次往返。
  // 排序键与站点侧 `getAllTags()` 无关，只用于「顺序还原」的逐条比对，
  // 所以这里按 (entry_id, tag_order) 取，和读侧 `db.ts` 的 `loadTagNamesOf` 同口径。
  const tagResult = await db.query<{ entry_id: string; name: string }>(
    `select et.entry_id, t.name
       from entry_tags et
       join tags t on t.id = et.tag_id
      order by et.entry_id, et.tag_order`,
  );
  const tagsOfEntry = new Map<string, string[]>();
  for (const row of tagResult.rows) {
    const list = tagsOfEntry.get(row.entry_id);
    if (list) list.push(row.name);
    else tagsOfEntry.set(row.entry_id, [row.name]);
  }

  const byKind: Record<string, Comparable[]> = { blog: [], projects: [], diary: [], goals: [] };

  for (const raw of result.rows) {
    const kind = String(raw.kind) as EntryKind;
    const comparable: Comparable = {
      kind,
      slug: String(raw.slug),
      title: String(raw.title),
      summary: String(raw.summary),
      body_md: String(raw.body_md),
      body_html: raw.body_html === null ? '' : String(raw.body_html),
      headings: [], // 库里不存 TOC，维度 9 单独按 body_md 重算
      published_at: toIsoTimestamp(raw.published_at),
      display_date: toDisplayDate(raw.display_date),
      data: (raw.data ?? {}) as Record<string, unknown>,
      // 关系表按 (entry_id, tag_order) 预排好，这里直接按 entry id 取。
      tags: tagsOfEntry.get(String(raw.id)) ?? [],
      featured: raw.featured === true,
      sort_order: Number(raw.sort_order),
      publish_status: String(raw.publish_status),
    };
    (byKind[kind] ??= []).push(comparable);
  }

  // 用与站点 lib 等价的比较器排序。Node 的 sort 是稳定的，
  // 而插入顺序与 `listSourceFiles()` 的文件名 sort 顺序一致，
  // 因此「同日期」的并列项在两路的相对顺序天然相同。
  //
  // 待办（P3）：这四个比较器是手抄自站点 lib 的排序规则，站点改了这里不会自动跟随。
  // P3 抽 ContentSource 时，应让接口暴露稳定的排序语义，compare.ts 改为对接口断言。
  const comparators: Record<string, (a: Comparable, b: Comparable) => number> = {
    // posts.ts:144  b.date.localeCompare(a.date)
    blog: (a, b) => (b.display_date ?? '').localeCompare(a.display_date ?? ''),
    // diary.ts:65   b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug)
    diary: (a, b) =>
      (b.display_date ?? '').localeCompare(a.display_date ?? '') ||
      a.slug.localeCompare(b.slug),
    // projects.ts:65  a.order - b.order || a.name.localeCompare(b.name)
    projects: (a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title),
    // goals.ts:69     a.order - b.order || a.title.localeCompare(b.title)
    goals: (a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title),
  };

  for (const kind of Object.keys(byKind)) {
    byKind[kind].sort(comparators[kind]);
  }

  return byKind;
}

/* -------------------------------------------------------------------------- */
/* 比对                                                                        */
/* -------------------------------------------------------------------------- */

const KIND_LABEL: Record<string, string> = {
  blog: 'blog（文章）',
  projects: 'projects（项目）',
  diary: 'diary（日记）',
  goals: 'goals（目标）',
};

/*
 * 下列 8 处遍历用的四类字面量只决定报告行的输出顺序，不参与判定，
 * 因此不与 ENTRY_KINDS 强绑定（真正有语义的是 listSourceFiles 的插入顺序）。
 */

/** 维度 1：行数。 */
function compareCounts(
  report: Report,
  markdown: Record<string, Comparable[]>,
  db: Record<string, Comparable[]>,
): void {
  report.section('维度 1 · 行数');
  let totalMarkdown = 0;
  let totalDb = 0;
  for (const kind of ['blog', 'projects', 'diary', 'goals']) {
    const left = markdown[kind]?.length ?? 0;
    const right = db[kind]?.length ?? 0;
    totalMarkdown += left;
    totalDb += right;
    if (left === right) {
      report.pass(`${KIND_LABEL[kind]}：${left} 行 / ${right} 行`);
    } else {
      report.fail('行数', kind, '*', `markdown ${left} 行 ≠ db ${right} 行`);
    }
  }
  if (totalMarkdown === totalDb) {
    report.pass(`四类合计：${totalMarkdown} 行（markdown）== ${totalDb} 行（db）`);
  }
}

/** 维度 2：slug 集合。 */
function compareSlugSets(
  report: Report,
  markdown: Record<string, Comparable[]>,
  db: Record<string, Comparable[]>,
): void {
  report.section('维度 2 · slug 集合');
  for (const kind of ['blog', 'projects', 'diary', 'goals']) {
    const left = new Set((markdown[kind] ?? []).map((item) => item.slug));
    const right = new Set((db[kind] ?? []).map((item) => item.slug));
    const missing = [...left].filter((slug) => !right.has(slug));
    const extra = [...right].filter((slug) => !left.has(slug));

    if (missing.length === 0 && extra.length === 0) {
      report.pass(`${KIND_LABEL[kind]}：${left.size} 个 slug 完全一致`);
      continue;
    }
    if (missing.length > 0) {
      report.fail('slug 集合', kind, missing.join(','), `db 侧缺少 ${missing.length} 个 slug`, [
        `缺少：${missing.join(', ')}`,
      ]);
    }
    if (extra.length > 0) {
      report.fail('slug 集合', kind, extra.join(','), `db 侧多出 ${extra.length} 个 slug`, [
        `多出：${extra.join(', ')}`,
      ]);
    }
  }
}

/** 维度 3：排序后的顺序。 */
function compareOrder(
  report: Report,
  markdown: Record<string, Comparable[]>,
  db: Record<string, Comparable[]>,
): void {
  report.section('维度 3 · 排序顺序');
  for (const kind of ['blog', 'projects', 'diary', 'goals']) {
    const left = (markdown[kind] ?? []).map((item) => item.slug);
    const right = (db[kind] ?? []).map((item) => item.slug);
    const mismatch: string[] = [];
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
      if (left[i] !== right[i]) mismatch.push(`#${i + 1}: markdown=${left[i] ?? '(无)'} / db=${right[i] ?? '(无)'}`);
    }
    if (mismatch.length === 0) {
      report.pass(`${KIND_LABEL[kind]}：${left.length} 行顺序完全一致`);
    } else {
      report.fail('排序', kind, '*', `${mismatch.length} 处顺序不同`, mismatch.slice(0, 6));
    }
  }
}

/** 维度 4：title / summary / body_md 逐字符。 */
function compareText(
  report: Report,
  markdown: Record<string, Comparable[]>,
  db: Record<string, Comparable[]>,
): void {
  report.section('维度 4 · 文本字段 title / summary / body_md（逐字符）');
  const fields: ReadonlyArray<{ key: 'title' | 'summary' | 'body_md'; label: string }> = [
    { key: 'title', label: 'title' },
    { key: 'summary', label: 'summary' },
    { key: 'body_md', label: 'body_md' },
  ];

  for (const kind of ['blog', 'projects', 'diary', 'goals']) {
    const right = new Map((db[kind] ?? []).map((item) => [item.slug, item]));
    let compared = 0;
    for (const left of markdown[kind] ?? []) {
      const counterpart = right.get(left.slug);
      if (!counterpart) continue;
      compared += 1;
      for (const field of fields) {
        const a = left[field.key];
        const b = counterpart[field.key];
        if (a === b) {
          report.checks += 1;
          continue;
        }
        const index = firstDiffIndex(a, b);
        const detail = [
          `长度 markdown=${a.length} / db=${b.length}，首个差异在第 ${index + 1} 个字符`,
          `markdown: ${excerpt(a, index)}`,
          `db      : ${excerpt(b, index)}`,
        ];
        report.fail(field.label, kind, left.slug, '逐字符不相同', detail);
      }
    }
    report.pass(`${KIND_LABEL[kind]}：${compared} 行的 title / summary / body_md 逐字符相同`);
  }
}

/**
 * 维度 5：body_html 逐字节 —— **P2 最关键的验收**。
 *
 * 库里存的是「导入时渲染一次」的 HTML；markdown 路是「读时现算」。
 * 两者必须逐字节相同，否则 P3 切库当天页面会静默变化。
 */
function compareBodyHtml(
  report: Report,
  markdown: Record<string, Comparable[]>,
  db: Record<string, Comparable[]>,
  goalsAltHtml: ReadonlyMap<string, string>,
): void {
  report.section('维度 5 · body_html 逐字节（最关键）');

  // 四类一视同仁：db 路已按 `renderOptionsForKind(kind)` 渲染，
  // 与导入脚本同源，因此 goals 不再需要特殊分支。
  for (const kind of ['blog', 'projects', 'diary', 'goals']) {
    const right = new Map((db[kind] ?? []).map((item) => [item.slug, item]));
    let identical = 0;
    for (const left of markdown[kind] ?? []) {
      const counterpart = right.get(left.slug);
      if (!counterpart) continue;
      if (left.body_html === counterpart.body_html) {
        report.checks += 1;
        identical += 1;
        continue;
      }
      const index = firstDiffIndex(left.body_html, counterpart.body_html);
      const detail = [
        `字节数 markdown=${left.body_html.length} / db=${counterpart.body_html.length}`,
        `首个差异在第 ${index + 1} 个字符`,
        `markdown: ${excerpt(left.body_html, index, 60)}`,
        `db      : ${excerpt(counterpart.body_html, index, 60)}`,
      ];
      // 根因兜底（仅 goals）：db 侧产物若等于「headingOffset 缺省 0」的渲染，
      // 而站点侧不等于它，说明 db 侧没带上 renderOptionsForKind 给出的偏移，
      // 差异来自渲染选项口径，而不是渲染管线本身。
      const alt = goalsAltHtml.get(`${kind}/${left.slug}`);
      if (alt !== undefined && counterpart.body_html === alt && left.body_html !== alt) {
        detail.push(
          `根因：db 侧产物 == 默认渲染（headingOffset 0），站点侧 != 默认渲染。`,
          `      db/mapping.ts 的 renderOptionsForKind(${kind}) 可能未被 db 侧渲染沿用到。`,
        );
      }
      report.fail('body_html', kind, left.slug, '逐字节不相同', detail);
    }
    report.pass(`${KIND_LABEL[kind]}：${identical} 行 body_html 逐字节相同`);
  }
}

/** 维度 6：时区正确性（display_date / published_at）。 */
function compareDates(
  report: Report,
  markdown: Record<string, Comparable[]>,
  db: Record<string, Comparable[]>,
  runStartedAt: number,
): void {
  report.section('维度 6 · 时区（display_date / published_at）');

  for (const kind of ['blog', 'diary']) {
    const right = new Map((db[kind] ?? []).map((item) => [item.slug, item]));
    let checked = 0;
    for (const left of markdown[kind] ?? []) {
      const counterpart = right.get(left.slug);
      if (!counterpart) continue;
      checked += 1;
      const expectedDisplay = left.display_date;
      // 东八区零点 == UTC 前一天 16:00
      //
      // 刻意重复 mapping.ts 的 EAST8_SUFFIX：这里是独立复算期望值，
      // 复用被测方的常量会让断言变成同义反复（自己算、自己比，永远绿）。
      const expectedPublished = new Date(`${expectedDisplay}T00:00:00+08:00`).toISOString();

      if (counterpart.display_date === expectedDisplay) {
        report.checks += 1;
      } else {
        report.fail('display_date', kind, left.slug, '与 frontmatter 的 date 不一致', [
          `期望 ${String(expectedDisplay)} / 实际 ${String(counterpart.display_date)}`,
        ]);
      }

      if (counterpart.published_at === expectedPublished) {
        report.checks += 1;
      } else {
        report.fail('published_at', kind, left.slug, '东八区零点换算不正确', [
          `期望 ${expectedPublished}（= ${String(expectedDisplay)} 的东八区零点）`,
          `实际 ${String(counterpart.published_at)}`,
        ]);
      }
    }
    report.pass(`${KIND_LABEL[kind]}：${checked} 行的 display_date 与 published_at 换算正确`);
  }

  for (const kind of ['projects', 'goals']) {
    let checked = 0;
    for (const row of db[kind] ?? []) {
      checked += 1;
      if (row.display_date === null) {
        report.checks += 1;
      } else {
        report.fail('display_date', kind, row.slug, '应为 null（该类型没有日期字段）', [
          `实际 ${String(row.display_date)}`,
        ]);
      }
      // projects/goals 的 published_at 取导入时刻，只能校验「落在这轮比对的窗口内」
      const stamp = row.published_at ? Date.parse(row.published_at) : Number.NaN;
      const inWindow =
        Number.isFinite(stamp) && stamp >= runStartedAt - 10 * 60 * 1000 && stamp <= Date.now() + 10 * 60 * 1000;
      if (inWindow) {
        report.checks += 1;
      } else {
        report.fail('published_at', kind, row.slug, '应取导入时刻却不在本轮窗口内', [
          `实际 ${String(row.published_at)}`,
        ]);
      }
    }
    report.pass(`${KIND_LABEL[kind]}：${checked} 行 display_date=null 且 published_at 为导入时刻`);
  }
}

/** 维度 7：data jsonb 键集合与值。 */
function compareData(
  report: Report,
  markdown: Record<string, Comparable[]>,
  db: Record<string, Comparable[]>,
): void {
  report.section('维度 7 · data jsonb（键集合 + 值）');
  for (const kind of ['blog', 'projects', 'diary', 'goals']) {
    const right = new Map((db[kind] ?? []).map((item) => [item.slug, item]));
    let identical = 0;
    for (const left of markdown[kind] ?? []) {
      const counterpart = right.get(left.slug);
      if (!counterpart) continue;
      const leftKeys = Object.keys(left.data).sort();
      const rightKeys = Object.keys(counterpart.data).sort();

      if (leftKeys.join(',') !== rightKeys.join(',')) {
        report.fail('data 键集合', kind, left.slug, '键集合不一致', [
          `markdown: [${leftKeys.join(', ')}]`,
          `db      : [${rightKeys.join(', ')}]`,
        ]);
        continue;
      }
      const leftCanonical = canonical(left.data);
      const rightCanonical = canonical(counterpart.data);
      if (leftCanonical === rightCanonical) {
        report.checks += 1;
        identical += 1;
        continue;
      }
      const index = firstDiffIndex(leftCanonical, rightCanonical);
      report.fail('data 值', kind, left.slug, '键相同但值不同', [
        `markdown: ${VERBOSE ? leftCanonical : excerpt(leftCanonical, index, 80)}`,
        `db      : ${VERBOSE ? rightCanonical : excerpt(rightCanonical, index, 80)}`,
      ]);
    }
    report.pass(`${KIND_LABEL[kind]}：${identical} 行 data 键集合与值完全一致`);
  }
}

/** 维度 8：列级元数据（featured / sort_order / publish_status）。 */
function compareScalars(
  report: Report,
  markdown: Record<string, Comparable[]>,
  db: Record<string, Comparable[]>,
): void {
  report.section('维度 8 · 列级元数据 featured / sort_order / publish_status');
  for (const kind of ['blog', 'projects', 'diary', 'goals']) {
    const right = new Map((db[kind] ?? []).map((item) => [item.slug, item]));
    let identical = 0;
    for (const left of markdown[kind] ?? []) {
      const counterpart = right.get(left.slug);
      if (!counterpart) continue;
      const problems: string[] = [];
      if (left.featured !== counterpart.featured) {
        problems.push(`featured: markdown=${left.featured} / db=${counterpart.featured}`);
      }
      if (left.sort_order !== counterpart.sort_order) {
        problems.push(`sort_order: markdown=${left.sort_order} / db=${counterpart.sort_order}`);
      }
      if (left.publish_status !== counterpart.publish_status) {
        problems.push(`publish_status: markdown=${left.publish_status} / db=${counterpart.publish_status}`);
      }
      if (problems.length === 0) {
        report.checks += 1;
        identical += 1;
        continue;
      }
      report.fail('列级元数据', kind, left.slug, '取值不一致', problems);
    }
    report.pass(`${KIND_LABEL[kind]}：${identical} 行 featured / sort_order / publish_status 一致`);
  }
}

/**
 * 维度 9：TOC 可重建性。
 *
 * 库里不存 `headings`（方案要求「读时计算」），所以这里验证的是：
 * 拿 `body_md` 重算出的 TOC 是否与站点现算的一字不差。
 */
function compareHeadings(
  report: Report,
  markdown: Record<string, Comparable[]>,
  dbBodyMd: ReadonlyMap<string, string>,
  extractHeadings: (markdown: string) => readonly unknown[],
): void {
  report.section('维度 9 · TOC 可重建（库不存 headings，按 body_md 重算）');
  for (const kind of ['blog', 'projects', 'diary', 'goals']) {
    let identical = 0;
    for (const left of markdown[kind] ?? []) {
      const body = dbBodyMd.get(`${kind}/${left.slug}`);
      if (body === undefined) continue;
      const rebuilt = normalizeHeadings(extractHeadings(body));
      if (rebuilt.join('\u0000') === left.headings.join('\u0000')) {
        report.checks += 1;
        identical += 1;
        continue;
      }
      report.fail('headings', kind, left.slug, '按 body_md 重算的 TOC 与站点不一致', [
        `markdown: ${JSON.stringify(left.headings)}`,
        `重算    : ${JSON.stringify(rebuilt)}`,
      ]);
    }
    report.pass(`${KIND_LABEL[kind]}：${identical} 行 TOC 可由 body_md 完全重建`);
  }
}

/**
 * 维度 10：标签（`tags` + `entry_tags`）。
 *
 * 站点侧 `PostMeta.tags` / `DiaryMeta.tags` 是 frontmatter 里的字符串数组；
 * 库里拆成两张关系表，顺序由 `entry_tags.tag_order` 保留。本维度验两件事：
 * 1. **集合与顺序**：逐篇 `tags` 数组逐元素相等（顺序错位也算差异 ——
 *    `PostCard.tsx:38` 的 `slice(0, 4)` 和标签页都依赖原序）；
 * 2. **依赖标签的派生结果**：`getAllTags()` 的计数与排序
 *    （`count` 降序、同 count 名字升序，见 `posts.ts:210-222`）。
 *
 * 第 2 项单列是因为它是**跨篇聚合**：单篇标签全对、但去重或排序口径不同时，
 * 只有这一项会红。
 */
function compareTags(
  report: Report,
  markdown: Record<string, Comparable[]>,
  db: Record<string, Comparable[]>,
): void {
  report.section('维度 10 · 标签集合与顺序（tags + entry_tags.tag_order）');

  for (const kind of ['blog', 'diary']) {
    const right = new Map((db[kind] ?? []).map((item) => [item.slug, item]));
    let identical = 0;
    let withTags = 0;

    for (const left of markdown[kind] ?? []) {
      const counterpart = right.get(left.slug);
      if (!counterpart) continue;
      if (left.tags.length > 0) withTags += 1;

      const leftText = left.tags.join('\u0000');
      const rightText = counterpart.tags.join('\u0000');
      if (leftText === rightText) {
        report.checks += 1;
        identical += 1;
        continue;
      }

      const firstDiff = firstDiffIndex(leftText, rightText);
      report.fail('标签', kind, left.slug, `标签不一致（首个差异在第 ${firstDiff} 个字符）`, [
        `markdown: ${JSON.stringify(left.tags)}`,
        `db      : ${JSON.stringify(counterpart.tags)}`,
      ]);
    }

    report.pass(
      `${KIND_LABEL[kind]}：${identical} 行标签集合与顺序一致（其中 ${withTags} 行有标签）`,
    );
  }

  // 派生：标签聚合计数 + 排序口径。站点侧公式在 `posts.ts:210-222`。
  const tally = (items: Comparable[]) => {
    const counter = new Map<string, number>();
    for (const item of items) {
      for (const tag of item.tags) counter.set(tag, (counter.get(tag) ?? 0) + 1);
    }
    return [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  };

  const leftTally = tally(markdown.blog ?? []);
  const rightTally = tally(db.blog ?? []);
  const leftText = leftTally.map((item) => `${item.tag}:${item.count}`).join('\u0000');
  const rightText = rightTally.map((item) => `${item.tag}:${item.count}`).join('\u0000');
  if (leftText === rightText) {
    report.pass(`getAllTags() 等价：${leftTally.length} 个标签，计数与排序全部一致`);
  } else {
    report.fail('标签聚合', 'blog', '*', 'getAllTags() 的标签集合 / 计数 / 排序不一致', [
      `markdown: ${JSON.stringify(leftTally)}`,
      `db      : ${JSON.stringify(rightTally)}`,
    ]);
  }

  // projects / goals 的站点类型没有 tags 字段，两路都必须是空数组。
  for (const kind of ['projects', 'goals']) {
    const stray = [...(markdown[kind] ?? []), ...(db[kind] ?? [])].filter(
      (item) => item.tags.length > 0,
    );
    if (stray.length === 0) {
      report.pass(`${KIND_LABEL[kind]}：两路均无 tags 字段（预期）`);
    } else {
      report.fail(
        '标签',
        kind,
        '*',
        `${stray.length} 行出现了不该有的标签`,
        stray.map((item) => `${item.slug}: ${JSON.stringify(item.tags)}`),
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const runStartedAt = Date.now();
  const report = new Report();

  /* -------------------- 加载各模块（hook 已就绪） -------------------- */
  const { createMigratedDatabase } = (await import('./verify')) as {
    createMigratedDatabase(options?: { migrationPath?: string }): Promise<{
      db: Queryable & { close(): Promise<void> };
      statements: string[];
    }>;
  };
  const { mapEntry, renderOptionsForKind, DEFAULT_SORT_ORDER } = (await import('./mapping')) as {
    mapEntry(
      kind: EntryKind,
      slug: string,
      raw: string,
      ctx: { publicDir: string; knownBlogSlugs?: readonly string[]; now?: () => Date },
    ):
      | {
          ok: true;
          row: Omit<DbRow, 'body_html' | 'tags'>;
          warnings: ValidationIssue[];
          body: string;
          /** 标签名（frontmatter 原序）；只有 blog/diary 非空。 */
          tags: string[];
        }
      | { ok: false; issues: ValidationIssue[] };
    /** 导入侧的渲染选项（goals 需要 headingOffset: 2）；唯一真源，本文件不复制。 */
    renderOptionsForKind(kind: EntryKind): { headingOffset: number };
    /** blog / diary 的固定排序值；唯一真源，本文件不复制。 */
    DEFAULT_SORT_ORDER: number;
  };
  const { ENTRY_KINDS } = (await import('@loxander/content-core')) as {
    /** 四类的规范顺序（含插入顺序语义）；唯一真源，本文件不复制。 */
    ENTRY_KINDS: readonly EntryKind[];
  };
  const { renderMarkdown, extractHeadings } = (await import('@loxander/markdown')) as {
    renderMarkdown(markdown: string, options?: { headingOffset?: number }): Promise<string>;
    extractHeadings(markdown: string): readonly unknown[];
  };

  report.title('P2 双路数据比对 · markdown 源 vs db 源');
  report.info(`仓库      ${REPO_ROOT}`);
  report.info(`内容目录  ${CONTENT_DIR}`);
  report.info(`封面目录  ${PUBLIC_DIR}`);
  report.info('db 路     PGlite 内存库（真实迁移 db/migrations/0000_init.sql + 0001_entry_tag_order.sql）');

  /* ------------------------- markdown 路 ------------------------- */
  const markdownSide = await readMarkdownSide(ENTRY_KINDS, DEFAULT_SORT_ORDER);
  report.info(
    `markdown 路 ${markdownSide.files.length} 个文件 ↔ 站点 lib 返回 ` +
      `${Object.values(markdownSide.ordered).reduce((sum, list) => sum + list.length, 0)} 条`,
  );

  /* --------------------------- db 路 --------------------------- */
  const { db, statements } = await createMigratedDatabase();
  report.info(`db 路     迁移 ${statements.length} 条语句执行完成`);

  const knownBlogSlugs = markdownSide.files
    .filter((file) => file.kind === 'blog')
    .map((file) => file.slug);

  const dbRows: DbRow[] = [];
  const mappedErrors: { file: string; issues: ValidationIssue[] }[] = [];
  const warnings: { file: string; issue: ValidationIssue }[] = [];
  // goals 的「默认渲染」变体（headingOffset 缺省 = 0），只在维度 5 出现差异时用于根因诊断
  const goalsAltHtml = new Map<string, string>();

  for (const file of markdownSide.files) {
    const label = `${file.kind}/${file.slug}.md`;
    const mapped = mapEntry(file.kind, file.slug, file.raw, {
      publicDir: PUBLIC_DIR,
      knownBlogSlugs,
    });

    if (!mapped.ok) {
      mappedErrors.push({ file: label, issues: mapped.issues });
      continue;
    }

    for (const issue of mapped.warnings) warnings.push({ file: label, issue });

    // 与 db/import.ts 的导入流程完全一致：渲染选项来自 mapping.ts 的 renderOptionsForKind(kind)，
    // 本文件**不**持有该常量的副本 —— 那是导入侧的唯一真源，复制就会漂移。
    const bodyHtml = await renderMarkdown(mapped.body, renderOptionsForKind(file.kind));
    // 对照变体：用渲染器默认选项（headingOffset 缺省 0）再渲染一次，仅用于差异根因诊断。
    // 键用 `kind/slug`，与维度 5 里的查找口径一致。
    if (file.kind === 'goals') {
      goalsAltHtml.set(`goals/${file.slug}`, await renderMarkdown(mapped.body));
    }

    dbRows.push({ ...mapped.row, body_html: bodyHtml, tags: [...mapped.tags] });
  }

  if (mappedErrors.length > 0) {
    report.section('映射失败的文件');
    for (const failure of mappedErrors) {
      report.fail(
        '导入映射',
        failure.file,
        '*',
        `${failure.issues.length} 条 blocking issue`,
        failure.issues.map((issue) => `${issue.field ?? '-'}: ${issue.message}`),
      );
    }
  }

  for (const row of dbRows) await insertRow(db, row);
  const tagLinks = await writeTagRelations(db, dbRows);
  report.info(`db 路     写入 ${dbRows.length} 行 entries + ${tagLinks} 条 entry_tags 关系`);

  if (warnings.length > 0 && VERBOSE) {
    report.section(`映射 warnings（${warnings.length} 条，不阻断）`);
    for (const item of warnings) {
      report.info(`${item.file} ${item.issue.field ?? '-'}: ${item.issue.message}`);
    }
  }

  const dbSide = await readDbSide(db, dbRows);

  /* --------------------------- 各维度 --------------------------- */
  compareCounts(report, markdownSide.ordered, dbSide);
  compareSlugSets(report, markdownSide.ordered, dbSide);
  compareOrder(report, markdownSide.ordered, dbSide);
  compareText(report, markdownSide.ordered, dbSide);
  compareBodyHtml(report, markdownSide.ordered, dbSide, goalsAltHtml);
  compareDates(report, markdownSide.ordered, dbSide, runStartedAt);
  compareData(report, markdownSide.ordered, dbSide);
  compareScalars(report, markdownSide.ordered, dbSide);

  const dbBodyMd = new Map<string, string>();
  for (const kind of ['blog', 'projects', 'diary', 'goals']) {
    for (const row of dbSide[kind] ?? []) dbBodyMd.set(`${kind}/${row.slug}`, row.body_md);
  }
  compareHeadings(report, markdownSide.ordered, dbBodyMd, extractHeadings);
  compareTags(report, markdownSide.ordered, dbSide);

  /* ------------------------ 已知缺口清单 ------------------------ */
  report.section('已知缺口（数据库结构上就无法还原的字段）');
  report.gap('PostMeta.readingTime：不入库（审查意见第 31 条），读时按 body_md 重算；本脚本不算它，也不比对');
  report.gap('PostMeta.cover / coverWidth / coverHeight：存 data jsonb，维度 7 已覆盖，不丢');
  for (const gap of report.gaps) report.info(`· ${gap}`);

  /* ---------------------------- 结论 ---------------------------- */
  await db.close();

  report.title('结论');
  report.info(`检查项 ${report.checks} 个，差异 ${report.diffs.length} 处`);
  if (report.diffs.length === 0) {
    report.info('✅ 两路数据完全等价，退出码 0');
  } else {
    const grouped = new Map<string, number>();
    for (const diff of report.diffs) {
      const key = `${diff.dim}（${diff.kind}）`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    for (const [key, count] of grouped) report.info(`❌ ${key}：${count} 处`);
    report.info('❌ 两路数据存在差异，退出码 1');
  }

  console.log(report.render());
  return report.diffs.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
      console.log(`\n=== EXIT=${code} ===`);
    })
    .catch((error: unknown) => {
      console.error('\n比对过程本身出错：');
      console.error(error);
      process.exitCode = 1;
      console.log('\n=== EXIT=1 ===');
    });
}

export { main };
