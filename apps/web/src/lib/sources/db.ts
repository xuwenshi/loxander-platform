/**
 * `ContentSource` 的 db 实现：从 Postgres 的 `entries` 表读内容。
 *
 * 数据由 `db/import.ts` + `db/mapping.ts` 写入，表结构见 `db/schema.ts`。
 *
 * ── 这份实现的目标 ────────────────────────────────────────────────────
 * 对**每一个** `ContentSource` 方法，返回值的字段名、字段值、排序、过滤条件
 * 都必须与 `sources/markdown.ts`（即现有四个 lib）一致。判断标准不是「看起来像」，
 * 而是 `db/compare.ts` 的三重比对（数量 / slug / 渲染快照）能全绿。
 *
 * 为此本文件刻意采用「SQL 只做过滤与粗排，细排与派生字段在内存里按 lib 原逻辑复刻」：
 * SQL 的 `ORDER BY title` 走数据库 collation（中文按字节/编码序），
 * 而 `lib/projects.ts:65` 用的是 `String.prototype.localeCompare`（ICU 排序，中文按拼音序），
 * 两者在中文标题上**结果会不同**。把二级比较放回内存用同一个 `localeCompare`，
 * 才能真正逐条对齐。
 *
 * ── 两处已知无法逐字节一致的地方（已上报，不在本文件偷偷绕过）──────────
 * 1. `readingTime`：站点用 `apps/web/src/lib/posts.ts:85-94` 的公式，输入是
 *    **未经 trim 的** `content`（含 frontmatter 后的空行）；库里存的是
 *    `db/mapping.ts:266` trim 过的 `body_md`。当前 10 篇实测两者算出同一个整数，
 *    但极端情况下（正文长度正好卡在 0.5 分钟边界）可能差 1。
 * 2. `goals` 的 `body_html`：**本文件不读 `body_html` 列，一律用 `body_md` 重渲染。**
 *    理由：站点 `lib/goals.ts:88` 用 `headingOffset: 2`（正文嵌在卡片里，`##` → `h4`），
 *    而渲染选项的唯一真源是 `db/mapping.ts:411-413` 的 `renderOptionsForKind(kind)`，
 *    导入器 `db/import.ts:221` 与 `db/compare.ts:1023` 都已改成按 kind 取选项。
 *    本文件复刻同一张表（`RENDER_HEADING_OFFSET`），因此**不走列值也不会漂移**；
 *    反过来若直接信列值，一旦某次导入用了旧版导入器（offset 0），站点会静默降级。
 *    两者本来等价（compare 维度 5 已逐字节验证），选择重渲染是为了「渲染口径只有一处」。
 *
 * ── 关于 `"use cache"` ───────────────────────────────────────────────
 * `lib/posts.ts:161` / `lib/projects.ts:85` / `lib/diary.ts:85` / `lib/goals.ts:79`
 * 的 `"use cache"` 有两个目的：缓存高亮开销，以及把 Shiki 内部读取的 `Date.now()`
 * 挡在缓存作用域之外（Cache Components 模式下不稳定值会直接报错）。
 *
 * 这里**只在四条详情路径上**声明 `"use cache"`（`getPost` / `getProject` /
 * `getDiaryEntry` / `getAllGoals`），因为它们是唯一会真正跑 Shiki 的路径，
 * 且与四个 lib 的缓存边界一一对应。列表方法不声明：它们不渲染正文，
 * 也不读不稳定值，缓存收益低于「切换数据源后要记得失效」的成本。
 *
 * **指令写在模块级 `async function` 上，对象方法只做一行转调**（见
 * `getPostDetail` / `getProjectDetail` / `getDiaryEntryDetail` / `getAllGoalsCached`），
 * 而不是直接写在对象方法体里。理由是证据不足：
 * - 官方文档（`node_modules/next/dist/docs/01-app/03-api-reference/01-directives/
 *   use-cache.md` 的 Usage 一节）只展示「函数声明 / 组件 / 文件级」三种写法；
 * - 我用 `node_modules/next/dist/build/swc` 的 `transform()` 直接探测过对象方法
 *   简写里的指令：顶层函数与对象方法**都没被改写成缓存调用**、指令字符串原样保留。
 *   但本项目构建走 Turbopack 而非 webpack 的 `next-swc-loader`，
 *   这条探测路径不能代表 Turbopack 的真实行为 —— 所以对该写法**结论是不可判定**。
 * 既然不可判定，就退回与四个 lib（`lib/posts.ts:161`、`lib/goals.ts:79` 等）
 * **完全相同的写法**：顶层 async 函数 + `"use cache"`。
 * 代价是多一层转调，收益是不必赌编译器行为。
 *
 * 仍未实测的部分：本机没有 Postgres，`CONTENT_SOURCE=db` 跑不起来，
 * 所以「缓存真的命中」这件事本身没有验证过；P3 切到 db 源后必须补一次
 * `next build` + 二次请求验证。
 */

import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { cacheTag } from "next/cache";

import { extractHeadings, renderMarkdown } from "@loxander/markdown";

import { entries, entryTags, tags as tagsTable } from "../../../../../db/schema";
import { entriesTag, entryTag, ALL_ENTRIES_TAG } from "../cache-tags";
import type { ContentSource } from "../content-source";
import { searchDocs, type SearchDoc } from "../search";
import { tagMatches } from "../tag-url";
import type {
  DiaryEntry,
  DiaryMeta,
  Goal,
  GoalMilestone,
  Post,
  PostMeta,
  Project,
  ProjectMeta,
  TagCount,
} from "@/types";

/* -------------------------------------------------------------------------- */
/* 数据库连接                                                                  */
/* -------------------------------------------------------------------------- */

/** drizzle 实例类型（postgres-js 驱动，无 schema 绑定）。 */
type Db = PostgresJsDatabase<Record<string, never>>;

interface Connection {
  db: Db;
  close: () => Promise<void>;
}

/** 进程内单例：读路径高频调用，不能每次查询都新建连接。 */
let cachedConnection: Promise<Connection> | undefined;

/**
 * 外部注入的 drizzle 实例。
 *
 * 生产永远走 `getDb()` 自己建连；这个钩子只用于**没有 Postgres 的场合**做等价性验证：
 * `db/compare.ts` 用 PGlite 跑真迁移，把 `drizzle-orm/pglite` 的实例注进来，
 * 就能让本文件跑完整的「导入 → 落库 → 读出」闭环，而不是对着内存对象断言。
 * 传 `undefined` 恢复默认行为。
 */
let injectedDb: Db | undefined;

/** 注入 / 清除 drizzle 实例（测试与离线比对工具有用）。 */
export function setDbContentSourceDatabase(db: Db | undefined): void {
  injectedDb = db;
}

/**
 * 取数据库连接（惰性、单例）。
 *
 * 用动态 `import()` 与 `lib/content-source.ts:160` 保持同一策略：
 * 只有真的走 db 源时，`postgres` / `drizzle-orm` 才进入模块图。
 */
async function getDb(): Promise<Db> {
  if (injectedDb) return injectedDb;

  cachedConnection ??= (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "[content-source/db] 缺少 DATABASE_URL。CONTENT_SOURCE=db 时必须提供 Postgres 连接串" +
          "（本地可先用 `node db/import.ts --dry-run` 检查映射结果）。",
      );
    }

    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");

    // max 保持保守：Next 的冷启动实例多，池子开大容易打满 Postgres 连接数上限。
    const client = postgres(url, { max: 5, onnotice: () => {} });

    return {
      db: drizzle(client) as Db,
      close: () => client.end({ timeout: 5 }),
    };
  })();

  return (await cachedConnection).db;
}

/** 清空连接缓存（测试 / 热重载用）。 */
export async function closeDbContentSourceConnection(): Promise<void> {
  if (!cachedConnection) return;
  const pending = cachedConnection;
  cachedConnection = undefined;
  const connection = await pending.catch(() => undefined);
  await connection?.close().catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* 行类型与基础读取                                                            */
/* -------------------------------------------------------------------------- */

/** `entries` 表的一行（只声明本文件用到的列）。 */
export type EntryRow = {
  /** 主键；读标签关系时要用。 */
  id: string;
  kind: string;
  slug: string;
  title: string;
  summary: string;
  body_md: string;
  body_html: string | null;
  publish_status: string;
  featured: boolean;
  sort_order: number;
  published_at: Date | null;
  display_date: string | null;
  data: Record<string, unknown>;
  /**
   * 该行的标签名，**顺序即 frontmatter 原序**（由 `entry_tags.tag_order` 保证）。
   *
   * 不来自 `entries` 表，由 `loadRows` 用 `loadTagNamesOf` 一次性批量填充；
   * 缺失时（如单元测试直接构造行）退化为 `NO_TAGS`。
   */
  tags?: string[];
};

/**
 * 开发环境显示草稿、生产环境隐藏 —— 与 `lib/posts.ts:25` / `lib/diary.ts:25`
 * 完全相同的判据（projects / goals 没有 draft 字段，不受影响）。
 */
const includeDrafts = process.env.NODE_ENV !== "production";

/** 生产环境只认 `published`；`scheduled` / `archived` 一律不对外可见。 */
function visibleOnly() {
  return eq(entries.publish_status, "published");
}

/**
 * 取某一分区的全部可见行（未排序，排序交给调用方的复刻比较器）。
 *
 * **标签**：`entries` 表没有 tags 列，标签在 `tags` + `entry_tags` 两张关系表里。
 * 这里在拿到行之后**一次性批量**补 `tags`（而不是留给 `toPostMeta` 逐行查），
 * 原因有二：
 * 1. `toPostMeta` / `toDiaryMeta` 是纯函数，还要被单测直接调用，不该碰数据库；
 * 2. 列表页一次取一整个分区，逐行查会变成 N+1。
 * 补不到（老库 / 未导入标签）时保留 `undefined`，由映射函数退化为 `NO_TAGS`。
 */
async function loadRows(kind: "blog" | "diary" | "projects" | "goals", options?: {
  /** 是否套用草稿过滤，默认 `true`（与四个 lib 一致）。 */
  applyDraftFilter?: boolean;
}): Promise<EntryRow[]> {
  const db = await getDb();
  const applyDraftFilter = options?.applyDraftFilter ?? true;

  const where =
    applyDraftFilter && !includeDrafts
      ? and(eq(entries.kind, kind), visibleOnly())
      : eq(entries.kind, kind);

  const rows = (await db.select().from(entries).where(where)) as unknown as EntryRow[];

  // 只有 blog / diary 有 tags（`lib/posts.ts:82` / `lib/diary.ts:52`）；
  // projects / goals 的 `ProjectMeta` / `Goal` 没有这个字段，省掉一次查询。
  if (kind === "blog" || kind === "diary") {
    const tagsOf = await loadTagNamesOf(
      db,
      rows.map((row) => row.id),
    );
    for (const row of rows) {
      row.tags = tagsOf.get(row.id) ?? NO_TAGS;
    }
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/* 派生字段                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 估算阅读时间（分钟）。
 *
 * **逐字复制** `apps/web/src/lib/posts.ts:85-94`（那个函数没有 export，
 * 而四个 lib 在本任务里是只读的，所以只能复制）。改动此处必须同步改那里，
 * 否则 markdown 源与 db 源的阅读时间会分叉。
 */
function estimateReadingTime(markdown: string): number {
  const cjkPattern = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
  const cjkCount = (markdown.match(cjkPattern) ?? []).length;
  const latinCount = (
    markdown.replace(cjkPattern, " ").match(/[A-Za-z0-9_'-]+/g) ?? []
  ).length;

  const minutes = cjkCount / 350 + latinCount / 200;
  return Math.max(1, Math.round(minutes));
}

/** 读 `data` 里的可选字符串，空串 / 缺失 / 非字符串都当 `undefined`。 */
function optionalString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 读 `data` 里的可选数字。 */
function optionalNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 读 `data` 里的字符串数组，缺失退化成 `[]`。 */
function stringArray(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * 标签的兜底空数组。
 *
 * `PostMeta.tags` / `DiaryMeta.tags` 是必填的 `string[]`，但有两种情况拿不到真值：
 * 1. 纯函数单测直接构造 `EntryRow` 字面量（不走数据库，没有 `loadRows` 回填）；
 * 2. 老库 / 尚未导入标签的数据（`entry_tags` 里没有对应行）。
 *
 * 真实读路径都由 `loadRows` 从 `entry_tags` 批量回填（见 `loadTagNamesOf`），
 * 不会落到这里。声明成可变类型是为满足 `PostMeta.tags: string[]`，
 * 但下面立刻 freeze —— 谁不小心 push 进去都会当场抛错，而不是静默污染所有行。
 */
const NO_TAGS: string[] = [];
Object.freeze(NO_TAGS);

/**
 * 按 `(entry_id, tag_order)` 读回单篇内容的标签名。
 *
 * 与 `tags.ts` 的关系：`tag_order` 是 P2 追加列（迁移 `0001_entry_tag_order.sql`），
 * 保证 frontmatter 里的标签顺序能精确还原 —— `PostCard.tsx:38` 的 `tags.slice(0, 4)`
 * 和 `diary/page.tsx:75` 都依赖这个顺序。
 *
 * 为什么一次性批量取（而不是每篇一条 SQL）：列表页一次要 4 篇 blog，
 * 逐篇查会产生 N+1；这里按 entry_id 集合查一次，再在内存里分组。
 */
async function loadTagNamesOf(
  db: Db,
  entryIds: readonly string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (entryIds.length === 0) return grouped;

  const rows = (await db
    .select({
      entryId: entryTags.entry_id,
      tagOrder: entryTags.tag_order,
      name: tagsTable.name,
    })
    .from(entryTags)
    .innerJoin(tagsTable, eq(tagsTable.id, entryTags.tag_id))
    .where(inArray(entryTags.entry_id, [...entryIds]))
    .orderBy(asc(entryTags.entry_id), asc(entryTags.tag_order))) as {
    entryId: string;
    tagOrder: number;
    name: string;
  }[];

  for (const row of rows) {
    const list = grouped.get(row.entryId);
    if (list) list.push(row.name);
    else grouped.set(row.entryId, [row.name]);
  }
  return grouped;
}

/* -------------------------------------------------------------------------- */
/* 行 → 站点类型的纯映射（导出，便于单测与 from-row 复用）                      */
/* -------------------------------------------------------------------------- */

/**
 * blog 行 → `PostMeta`。
 *
 * 字段来源对照 `apps/web/src/lib/posts.ts:116-129`：
 * - `description` ← `summary` 列（导入时 `db/mapping.ts:294` 把 description 写进 summary）
 * - `date` ← `display_date` 列
 * - `category` / `cover` / 封面尺寸 ← `data`
 * - `coverWidth` / `coverHeight` 只在 data 里有时才出现（与 lib 的条件展开一致）
 */
export function toPostMeta(row: EntryRow): PostMeta {
  const cover = optionalString(row.data, "cover");
  const coverWidth = optionalNumber(row.data, "coverWidth");
  const coverHeight = optionalNumber(row.data, "coverHeight");

  return {
    slug: row.slug,
    title: row.title,
    description: row.summary,
    date: row.display_date ?? "",
    // 由 `loadRows` 从 `entry_tags` 批量回填；纯函数单测里没回填时退化为空数组。
    tags: row.tags ?? NO_TAGS,
    category: optionalString(row.data, "category") ?? "未分类",
    // 注意：这里**不加**条件展开 —— `lib/posts.ts:124` 的 `cover: entry.cover`
    // 无论有没有封面都会产出这个键（值为 `undefined`），保持键集合一致，
    // 这样 `"cover" in post` 一类的判断在两实现下行为相同。
    cover,
    ...(coverWidth === undefined || coverHeight === undefined
      ? {}
      : { coverWidth, coverHeight }),
    draft: row.publish_status === "draft",
    readingTime: estimateReadingTime(row.body_md),
  };
}

/** diary 行 → `DiaryMeta`（对照 `apps/web/src/lib/diary.ts:47-55`）。 */
export function toDiaryMeta(row: EntryRow): DiaryMeta {
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    date: row.display_date ?? "",
    mood: optionalString(row.data, "mood"),
    // 同 `toPostMeta`：由 `loadRows` 从 `entry_tags` 批量回填。
    tags: row.tags ?? NO_TAGS,
    draft: row.publish_status === "draft",
  };
}

/** projects 行 → `ProjectMeta`（对照 `apps/web/src/lib/projects.ts:44-57`）。 */
export function toProjectMeta(row: EntryRow): ProjectMeta {
  return {
    slug: row.slug,
    // 列里存的是 frontmatter 的 `name`（db/mapping.ts:345）。
    name: row.title,
    description: row.summary,
    techStack: stringArray(row.data, "techStack"),
    status: (optionalString(row.data, "status") ?? "active") as ProjectMeta["status"],
    period: optionalString(row.data, "period"),
    role: optionalString(row.data, "role"),
    github: optionalString(row.data, "github"),
    demo: optionalString(row.data, "demo"),
    article: optionalString(row.data, "article"),
    featured: row.featured,
    order: row.sort_order,
  };
}

/** goals 行 → `Goal` 的元信息部分（对照 `apps/web/src/lib/goals.ts:47-61`）。 */
export function toGoalMeta(row: EntryRow): Omit<Goal, "html" | "headings"> {
  const milestones = Array.isArray(row.data.milestones)
    ? (row.data.milestones as GoalMilestone[])
    : [];

  return {
    slug: row.slug,
    title: row.title,
    horizon: (optionalString(row.data, "horizon") ?? "short") as Goal["horizon"],
    status: (optionalString(row.data, "status") ?? "planned") as Goal["status"],
    progress: optionalNumber(row.data, "progress") ?? 0,
    period: optionalString(row.data, "period"),
    order: row.sort_order,
    milestones,
  };
}

/* -------------------------------------------------------------------------- */
/* 排序比较器（与四个 lib 逐字一致）                                            */
/* -------------------------------------------------------------------------- */

/**
 * `lib/posts.ts:144`：**只有** `b.date.localeCompare(a.date)`，没有第二级比较键。
 *
 * 并列排序因此依赖两件事：`Array.prototype.sort` 稳定（ES2019 起由规范保证），
 * 以及输入顺序 = 文件名升序（`lib/posts.ts:30-36` 的 `readdirSync().filter().sort()`）。
 * 所以这里先按 slug 做一次码点序预排（与文件名 `.sort()` 的默认比较一致），
 * 再稳定排序日期 —— 不能简单地加一个 `localeCompare` 第二级键，
 * 因为 `localeCompare` 在 `-` 等标点上与码点序**不等价**（`'a-b'` vs `'ab'`）。
 */
function sortPosts(rows: EntryRow[]): EntryRow[] {
  return [...rows]
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .sort((a, b) => (b.display_date ?? "").localeCompare(a.display_date ?? ""));
}

/** `lib/diary.ts:65`：`b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug)`。 */
function sortDiary(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort(
    (a, b) =>
      (b.display_date ?? "").localeCompare(a.display_date ?? "") ||
      a.slug.localeCompare(b.slug),
  );
}

/**
 * `lib/projects.ts:65`：`a.order - b.order || a.name.localeCompare(b.name)`。
 * 注意 `a.name` 对应 `title` 列，且用 `localeCompare`（ICU），不是 SQL collation。
 */
function sortProjects(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort(
    (a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title),
  );
}

/** `lib/goals.ts:69`：`a.order - b.order || a.title.localeCompare(b.title)`。 */
function sortGoals(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort(
    (a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title),
  );
}

/* -------------------------------------------------------------------------- */
/* 正文 / 渲染                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 各类内容在**站点上**渲染正文时使用的 `headingOffset`。
 *
 * **必须与 `db/mapping.ts:411-413` 的 `renderOptionsForKind(kind)` 逐键一致** ——
 * 那里是「导入时生成 `body_html`」的唯一真源，这里是「读出来重渲染」的唯一真源。
 * 两者一旦分叉，`body_html` 列与站点渲染就永久漂移，而 `db/compare.ts`
 * 的维度 5（body_html 逐字节）只在跑比对时才会发现。
 *
 * - `goals: 2` —— `apps/web/src/lib/goals.ts:88`，正文嵌在卡片里，`##` → `h4`；
 * - 其余三类 `0` —— `lib/posts.ts:167` / `lib/projects.ts:91` / `lib/diary.ts:91`。
 */
const RENDER_HEADING_OFFSET: Record<"blog" | "diary" | "projects" | "goals", number> = {
  blog: 0,
  diary: 0,
  projects: 0,
  goals: 2,
};

/**
 * 渲染正文 HTML 与目录。
 *
 * 输入一律是 `body_md`（导入时已 `trim`，见 `db/mapping.ts:266`）；
 * 实测 trim 前后渲染产物逐字节相同，所以能对得上 markdown 源的产物。
 *
 * **刻意不读 `body_html` 列**：列值与这里重渲染的结果本来等价
 * （`db/compare.ts` 维度 5 已逐字节验证），选择重渲染是为了让渲染口径只有一处 ——
 * 若某次导入用了旧版导入器（goals 用 offset 0），直接信列值会让站点静默降级，
 * 而重渲染这条路与 `renderOptionsForKind` 对齐后永远不会错。
 */
async function renderBody(row: EntryRow, kind: keyof typeof RENDER_HEADING_OFFSET) {
  const body = row.body_md;
  const headingOffset = RENDER_HEADING_OFFSET[kind];
  const [html, headings] = await Promise.all([
    renderMarkdown(body, headingOffset === 0 ? undefined : { headingOffset }),
    Promise.resolve(extractHeadings(body)),
  ]);
  return { html, headings };
}

/* -------------------------------------------------------------------------- */
/* 带缓存的详情路径                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 下面四个函数是**唯一**带 `"use cache"` 的地方，与四个 lib 的缓存边界一一对应：
 * `lib/posts.ts:161` `getPost` / `lib/projects.ts:85` `getProject` /
 * `lib/diary.ts:85` `getDiaryEntry` / `lib/goals.ts:79` `getAllGoals`。
 *
 * 为什么是顶层函数而不是对象方法上的指令，见文件头「关于 `"use cache"`」。
 * 函数参数就是缓存键的一部分（`slug`），与 lib 里的做法一致。
 */

async function getPostDetail(slug: string): Promise<Post | null> {
  "use cache";

  // 标签来自 `lib/cache-tags.ts` 的唯一定义处，不在这里拼字符串：
  // 拼错一个字符的后果是「后台发布后前台纹丝不动」，而且没有任何报错。
  // 详情页只需失效「这一篇」，不用连带整个 blog 列表 —— 正文改动不影响列表卡片。
  cacheTag(entryTag("blog", slug));

  const row = sortPosts(await loadRows("blog")).find((item) => item.slug === slug);
  if (!row) return null;

  const { html, headings } = await renderBody(row, "blog");
  return { ...toPostMeta(row), html, headings } satisfies Post;
}

async function getProjectDetail(slug: string): Promise<Project | null> {
  "use cache";

  cacheTag(entryTag("projects", slug));

  const row = sortProjects(await loadRows("projects")).find((item) => item.slug === slug);
  if (!row) return null;

  const { html, headings } = await renderBody(row, "projects");
  return { ...toProjectMeta(row), html, headings } satisfies Project;
}

async function getDiaryEntryDetail(slug: string): Promise<DiaryEntry | null> {
  "use cache";

  cacheTag(entryTag("diary", slug));

  const row = sortDiary(await loadRows("diary")).find((item) => item.slug === slug);
  if (!row) return null;

  const { html, headings } = await renderBody(row, "diary");
  return { ...toDiaryMeta(row), html, headings } satisfies DiaryEntry;
}

/**
 * 与 `lib/goals.ts:78-92` 一致：列表页直接渲染全部正文，整个列表一次缓存。
 *
 * **这里重新渲染 `body_md` 而不是读 `body_html` 列**：两者本该等价
 * （导入器 `db/import.ts:221` 已按 `renderOptionsForKind('goals')` 写入 offset 2，
 *  `db/compare.ts:1023` 同样如此），但渲染口径只认
 *  `db/mapping.ts:411-413` 那一个函数；本文件复刻成 `RENDER_HEADING_OFFSET`，
 *  两边任一侧未来改动都由 `db/compare.ts` 维度 5（body_html 逐字节）兜底。
 *  之所以不直接信列值：若某次导入用了旧版导入器（offset 0），
 *  直接读列会让所有 goals 标题静默降级。
 */
async function getAllGoalsCached(): Promise<Goal[]> {
  "use cache";

  // goals 没有详情页（列表页直接渲染全部正文），所以只打列表标签。
  cacheTag(entriesTag("goals"), ALL_ENTRIES_TAG);

  return Promise.all(
    sortGoals(await loadRows("goals")).map(async (row) => {
      const { html, headings } = await renderBody(row, "goals");
      return { ...toGoalMeta(row), html, headings } satisfies Goal;
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* 带缓存的列表路径                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 列表数据的缓存入口，**一个分区一个**，供该分区的所有派生方法共用。
 *
 * ── 为什么要把「取列表」单独抽成缓存函数 ─────────────────────────────
 * 同一个 blog 列表被 5 个方法消费：`getAllPosts` / `getRecentPosts` /
 * `getAdjacentPosts` / `getRelatedPosts` / `getAllTags`。
 * 若各自查库，渲染一个 `/blog/[slug]` 页面会打 3 次同样的
 * `select ... from entries where kind='blog'`（详情 + 相邻 + 相关），
 * 而它们的结果**逐字节相同**。抽成一个 `"use cache"` 函数后，
 * 同一请求内后续调用直接命中缓存，数据库只被问一次。
 *
 * ── 标签怎么打 ──────────────────────────────────────────────────────
 * - `entries:<kind>`：本分区列表变了（新增/删除/改元信息）
 * - `entries:all`：跨分区页面（首页、星图、关于、sitemap、RSS）也读它
 *
 * 详情页的正文改动**不会**打到这两个标签上（那只打 `entry:<kind>:<slug>`），
 * 所以改一篇文章的正文不会让列表页白重算 —— 这是「精确失效」的意义所在。
 *
 * ── 为什么不缓存「草稿过滤后的列表」 ────────────────────────────────
 * `includeDrafts` 读 `process.env.NODE_ENV`，那是**构建期常量**，
 * 同一个部署里不会变，所以过滤结果不会因请求而异，可以安全缓存。
 */
async function getAllPostsCached(): Promise<PostMeta[]> {
  "use cache";

  cacheTag(entriesTag("blog"), ALL_ENTRIES_TAG);

  return sortPosts(await loadRows("blog")).map(toPostMeta);
}

async function getAllProjectsCached(): Promise<ProjectMeta[]> {
  "use cache";

  cacheTag(entriesTag("projects"), ALL_ENTRIES_TAG);

  return sortProjects(await loadRows("projects")).map(toProjectMeta);
}

async function getAllDiaryCached(): Promise<DiaryMeta[]> {
  "use cache";

  cacheTag(entriesTag("diary"), ALL_ENTRIES_TAG);

  return sortDiary(await loadRows("diary")).map(toDiaryMeta);
}

/* -------------------------------------------------------------------------- */
/* 工厂                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 创建 db 内容源。
 *
 * 方法顺序与 `ContentSource` 接口一致，便于对照 review。
 */
export function createDbContentSource(): ContentSource {
  return {
    kind: "db",

    /* ------------------------------ blog ------------------------------ */

    /**
     * 与 `lib/posts.ts:39-41` 一致：**只列文件名，不套草稿过滤**。
     * 它被 `projects.article` 的引用完整性检查用到，需要「磁盘上/库里有这么一篇」，
     * 而不是「这篇文章对外可见」。
     */
    async getBlogSlugs() {
      const rows = await loadRows("blog", { applyDraftFilter: false });
      return rows.map((row) => row.slug).sort();
    },

    async getAllPosts() {
      return getAllPostsCached();
    },

    async getRecentPosts(limit = 3) {
      return (await getAllPostsCached()).slice(0, limit);
    },

    /** 转调到带 `"use cache"` 的 `getPostDetail`（见文件头）。 */
    async getPost(slug: string) {
      return getPostDetail(slug);
    },

    /** 与 `lib/posts.ts:175-188` 同一套「倒序列表里 index-1 更新」的语义。 */
    async getAdjacentPosts(slug: string) {
      const posts = await getAllPostsCached();
      const index = posts.findIndex((post) => post.slug === slug);
      if (index === -1) return { prev: null, next: null };

      return {
        prev: index > 0 ? posts[index - 1] : null,
        next: index < posts.length - 1 ? posts[index + 1] : null,
      };
    },

    /**
     * 与 `lib/posts.ts:191-207` 同分同排序。
     *
     * 计分：`sharedTags * 2 + sameCategory`，过滤 `score > 0`，
     * 排序 `score 降序 || date 降序`（date 是字符串比较，与 lib 一致）。
     * 标签来自 `loadRows` 回填的 `entry_tags`（`tag_order` 保序），
     * 所以 db 源与 markdown 源的重合项集合必须是同一个。
     */
    async getRelatedPosts(slug: string, limit = 3) {
      const posts = await getAllPostsCached();
      const current = posts.find((post) => post.slug === slug);
      if (!current) return [];

      return posts
        .filter((post) => post.slug !== slug)
        .map((post) => {
          const sharedTags = post.tags.filter((tag) => current.tags.includes(tag)).length;
          const sameCategory = post.category === current.category ? 1 : 0;
          return { post, score: sharedTags * 2 + sameCategory };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || b.post.date.localeCompare(a.post.date))
        .slice(0, limit)
        .map((entry) => entry.post);
    },

    /**
     * 与 `lib/posts.ts:210-222` 同逻辑：按标签计数，`count` 降序、同 `count` 按名字升序。
     *
     * 标签来自 `entry_tags` 关系表（`loadRows` 批量回填），不再是空数组 ——
     * 否则 `/(site)/tags` 在 db 源下会静默变空。
     */
    async getAllTags() {
      const counter = new Map<string, number>();

      for (const post of await getAllPostsCached()) {
        for (const tag of post.tags) {
          counter.set(tag, (counter.get(tag) ?? 0) + 1);
        }
      }

      return [...counter.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    },

    async getAllCategories() {
      const counter = new Map<string, number>();

      for (const post of await getAllPostsCached()) {
        counter.set(post.category, (counter.get(post.category) ?? 0) + 1);
      }

      return [...counter.entries()]
        .map(([category, count]) => ({ tag: category, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)) satisfies TagCount[];
    },

    /* ------------------- P5：标签页与服务端搜索 ------------------- */

    /**
     * 与 `lib/posts.ts` 的 `getPostsByTag` 同口径：走 `tagMatches()` 做大小写不敏感匹配。
     *
     * 复用 `getAllPostsCached()` 而不是自己查库，两个理由：
     * 1. 列表已经是缓存过的，标签页再查一次纯属浪费；
     * 2. 两路（markdown / db）必须共用**同一份** `PostMeta`，否则标签页在两种
     *    内容源下会给出不同的排序 —— 那正是 `db:compare` 想防的事。
     *
     * 注意这里**不做** slug 归一化：归一化只发生在 URL 边界（`lib/tag-url.ts`），
     * 传进来的是路由段原文，`tagMatches` 负责剩下的（含 `+` 当空格、畸形编码兜底）。
     */
    async getPostsByTag(tag: string) {
      return (await getAllPostsCached()).filter((post) =>
        post.tags.some((name) => tagMatches(name, tag)),
      );
    },

    /**
     * 服务端搜索，**刻意不套 `"use cache"`**。
     *
     * 方案 §14.2 的缓存策略把「搜索」单列为「动态查询」，这里与之一致：
     * 同一篇文章被搜到的顺序取决于查询词，缓存键会立刻爆炸；
     * 而候选集本身只有几十篇，重算成本远低于维护一份正确的缓存失效图。
     *
     * 但候选集**仍然来自** `loadRows("blog")`（不是缓存函数）——
     * 因为 `getAllPostsCached()` 返回的 `PostMeta` 已经把正文裁掉了（`toPostMeta`），
     * 而搜索要打正文分。少一次缓存命中，换来不用为「正文」再造一份缓存。
     */
    async searchPosts(query: string) {
      const rows = await loadRows("blog");
      const docs: SearchDoc[] = rows.map((row) => ({
        ...toPostMeta(row),
        body: row.body_md,
      }));
      return searchDocs(docs, query);
    },

    /* ---------------------------- projects ---------------------------- */

    async getAllProjects() {
      return getAllProjectsCached();
    },

    /** 与 `lib/projects.ts:74-78` 一致：没有 featured 时退回全部。 */
    async getFeaturedProjects(limit = 3) {
      const projects = await getAllProjectsCached();
      const featured = projects.filter((project) => project.featured);
      return (featured.length > 0 ? featured : projects).slice(0, limit);
    },

    /** 转调到带 `"use cache"` 的 `getProjectDetail`（见文件头）。 */
    async getProject(slug: string) {
      return getProjectDetail(slug);
    },

    /* ----------------------------- diary ------------------------------ */

    async getAllDiaryEntries() {
      return getAllDiaryCached();
    },

    /**
     * 与 `lib/diary.ts:79-81` 一致：走 `getAllDiaryEntries`，
     * 因此**会**套用草稿过滤（与 `getBlogSlugs` 不同）。
     */
    async getDiarySlugs() {
      return (await getAllDiaryCached()).map((entry) => entry.slug);
    },

    /** 转调到带 `"use cache"` 的 `getDiaryEntryDetail`（见文件头）。 */
    async getDiaryEntry(slug: string) {
      return getDiaryEntryDetail(slug);
    },

    /* ----------------------------- goals ------------------------------ */

    /** 转调到带 `"use cache"` 的 `getAllGoalsCached`（见该函数的注释）。 */
    async getAllGoals() {
      return getAllGoalsCached();
    },
  };
}
