/**
 * 内容源抽象层（ContentSource）：把「页面要什么」与「内容从哪来」解耦。
 *
 * 现在有两种实现，由环境变量 `CONTENT_SOURCE` 选择：
 * - `markdown`（默认）：读仓库里的 `content/{blog,diary,projects,goals}/*.md`，
 *   即 P0/P1 沿用的文件系统路径；
 * - `db`：读 Postgres 的 `entries` 表（P2 导入脚本产出）。
 *
 * ── 为什么方法全是异步的 ─────────────────────────────────────────────
 * 现有四个 lib（posts / projects / diary / goals）共 15 个导出函数，其中 11 个是**同步**的，
 * 因为 `fs.readFileSync` 可以同步（另外 4 个 `getPost` / `getProject` / `getDiaryEntry` /
 * `getAllGoals` 本来就异步，要跑 Shiki）。DB 驱动没有同步路（postgres-js 只有 Promise），
 * 所以接口只能统一成 `Promise`。这是唯一的签名偏差：
 * **函数名、参数、返回值类型（不含 Promise 包装）与现有 lib 一一对应**。
 *
 * 页面侧的迁移成本是机械的：`const posts = getAllPosts()` → `const posts = await src.getAllPosts()`，
 * 同步组件 → `async` 组件（`generateStaticParams` 本来就允许 async）。
 * 受影响调用点见返回给 lead 的清单。
 *
 * ── 为什么工厂函数也是异步的 ─────────────────────────────────────────
 * 这样可以 `await import('./sources/db')` **惰性加载** DB 实现：
 * markdown 模式下 `postgres` / `drizzle-orm` / `server-only` 根本不会进入模块图，
 * 构建产物与 P1 保持一致。代价是每处调用多一个 `await`，
 * 但既然所有取数方法都已经是 `await`，这点增量可忽略。
 */

import type {
  DiaryEntry,
  DiaryMeta,
  Goal,
  Post,
  PostMeta,
  Project,
  ProjectMeta,
  TagCount,
} from "@/types";

/** 内容源种类。 */
export type ContentSourceKind = "markdown" | "db";

/** 选择内容源的环境变量名。 */
export const CONTENT_SOURCE_ENV = "CONTENT_SOURCE";

/** 默认值：不设置该环境变量时走文件系统，保证现有行为不变。 */
export const DEFAULT_CONTENT_SOURCE: ContentSourceKind = "markdown";

/** 允许取值，用于校验与报错文案。 */
export const CONTENT_SOURCE_KINDS = ["markdown", "db"] as const satisfies readonly ContentSourceKind[];

/**
 * 内容源统一接口。
 *
 * 每个方法都对应现有 lib 的一个导出函数，逐个对齐：
 *
 * | 接口方法              | 对应实现处                     | 原签名 |
 * | --------------------- | ------------------------------ | ------ |
 * | `getBlogSlugs`        | `lib/posts.ts:39`              | `(): string[]` |
 * | `getAllPosts`         | `lib/posts.ts:141`             | `(): PostMeta[]` |
 * | `getRecentPosts`      | `lib/posts.ts:148`             | `(limit = 3): PostMeta[]` |
 * | `getPost`             | `lib/posts.ts:160`             | `(slug): Promise<Post \| null>` |
 * | `getAdjacentPosts`    | `lib/posts.ts:175`             | `(slug): { prev; next }` |
 * | `getRelatedPosts`     | `lib/posts.ts:191`             | `(slug, limit = 3): PostMeta[]` |
 * | `getAllTags`          | `lib/posts.ts:210`             | `(): TagCount[]` |
 * | `getAllCategories`    | `lib/posts.ts:225`             | `(): TagCount[]` |
 * | `getPostsByTag`       | **P5 新增**，无对应旧函数       | `(tag): PostMeta[]` |
 * | `searchPosts`         | **P5 新增**，无对应旧函数       | `(query): PostMeta[]` |
 * | `getAllProjects`      | `lib/projects.ts:69`           | `(): ProjectMeta[]` |
 * | `getFeaturedProjects` | `lib/projects.ts:74`           | `(limit = 3): ProjectMeta[]` |
 * | `getProject`          | `lib/projects.ts:84`           | `(slug): Promise<Project \| null>` |
 * | `getAllDiaryEntries`  | `lib/diary.ts:69`              | `(): DiaryMeta[]` |
 * | `getDiarySlugs`       | `lib/diary.ts:79`              | `(): string[]` |
 * | `getDiaryEntry`       | `lib/diary.ts:84`              | `(slug): Promise<DiaryEntry \| null>` |
 * | `getAllGoals`         | `lib/goals.ts:78`              | `(…): Promise<Goal[]>` |
 *
 * `kind` 是唯一新增成员，用于日志与断言「当前到底走了哪条路」。
 *
 * ── 关于 `tags`（P2 补齐后已无缺口）────────────────────────────────────
 * 曾经这里记着一条 TODO：db 源下 `PostMeta.tags` / `DiaryMeta.tags` 恒为 `[]`，
 * 因为 P2 首轮没把 frontmatter 的 `tags` 导入 `tags` / `entry_tags` 两张关系表。
 * **那条缺口已经补上**：`db/import.ts` 的 `writeTagRelations()` 负责写关系，
 * `sources/db.ts` 的 `loadTagNamesOf()` 按 `tag_order` 批量读回，顺序即
 * frontmatter 原序。`db/compare.ts` 的维度 10 与 14 条双实现等价测试都在守护它。
 *
 * 所以两路实现的 `tags` / `getAllTags()` / `getRelatedPosts()` 语义完全一致，
 * 不存在「db 源下标签静默变空」这回事。
 */
export interface ContentSource {
  /** 当前实现在读哪种内容源。 */
  readonly kind: ContentSourceKind;

  /* ------------------------------ blog ------------------------------ */

  /** 已知的 blog slug（**不过滤草稿**，与 `posts.ts:39` 一致）。 */
  getBlogSlugs(): Promise<string[]>;

  /** 全部文章元信息，按 `date` 倒序。 */
  getAllPosts(): Promise<PostMeta[]>;

  /** 首页 / 侧栏用的精选文章。 */
  getRecentPosts(limit?: number): Promise<PostMeta[]>;

  /** 单篇文章（含渲染后的 HTML 与目录），不存在返回 `null`。 */
  getPost(slug: string): Promise<Post | null>;

  /** 上一篇 / 下一篇（按时间倒序列表的相邻项）。 */
  getAdjacentPosts(
    slug: string,
  ): Promise<{ prev: PostMeta | null; next: PostMeta | null }>;

  /** 相关文章：标签重合权重 2、同分类权重 1。 */
  getRelatedPosts(slug: string, limit?: number): Promise<PostMeta[]>;

  /** 全部标签及数量，按数量倒序。 */
  getAllTags(): Promise<TagCount[]>;

  /** 全部分类及数量，按数量倒序。 */
  getAllCategories(): Promise<TagCount[]>;

  /**
   * 某个标签下的全部文章（P5 新增），按 `date` 倒序。
   *
   * 标签匹配**大小写不敏感**：`/tags/RAG` 与 `/tags/rag` 是同一个页面。
   * 理由见 `lib/tag-url.ts`：URL 一律小写，而标签名是原样存的（`"RAG"`），
   * 不归一化的话 `/tags/RAG` 会渲染「暂无内容」，看起来像数据丢了。
   *
   * 不存在的标签返回空数组、不抛错 —— 由页面决定渲染 404 还是空状态。
   */
  getPostsByTag(tag: string): Promise<PostMeta[]>;

  /**
   * 服务端搜索（P5 新增）：只搜文章、只返回已发布内容。
   *
   * 匹配与排序语义**唯一实现在 `lib/search.ts`**，两个内容源都调它，
   * 因此不会出现「markdown 源搜得到、db 源搜不到」这类漂移。
   */
  searchPosts(query: string): Promise<PostMeta[]>;

  /* ---------------------------- projects ---------------------------- */

  /** 全部项目元信息，按 `order` 升序再按 `name`。 */
  getAllProjects(): Promise<ProjectMeta[]>;

  /** 首页展示的精选项目（没有精选时退回全部）。 */
  getFeaturedProjects(limit?: number): Promise<ProjectMeta[]>;

  /** 单个项目（含渲染后的 HTML 与目录），不存在返回 `null`。 */
  getProject(slug: string): Promise<Project | null>;

  /* ----------------------------- diary ------------------------------ */

  /** 全部日记，按 `date` 倒序再按 `slug`。 */
  getAllDiaryEntries(): Promise<DiaryMeta[]>;

  /** `generateStaticParams` 用的 slug 列表（**过滤草稿**，与 `diary.ts:79` 一致）。 */
  getDiarySlugs(): Promise<string[]>;

  /** 单篇日记（含渲染后的 HTML 与目录），不存在返回 `null`。 */
  getDiaryEntry(slug: string): Promise<DiaryEntry | null>;

  /* ----------------------------- goals ------------------------------ */

  /** 全部目标（按 `order` 升序），正文已按 `headingOffset: 2` 渲染。 */
  getAllGoals(): Promise<Goal[]>;
}

/**
 * 解析 `CONTENT_SOURCE` 的取值（纯函数，便于测试）。
 *
 * @param raw 环境变量原始值，`undefined` / 空串按默认值处理
 * @throws 取值不在 {@link CONTENT_SOURCE_KINDS} 内时抛错，避免拼错后**静默**回退到 markdown
 */
export function resolveContentSourceKind(raw?: string): ContentSourceKind {
  const value = raw?.trim();
  if (!value) return DEFAULT_CONTENT_SOURCE;

  if ((CONTENT_SOURCE_KINDS as readonly string[]).includes(value)) {
    return value as ContentSourceKind;
  }

  throw new Error(
    `[content-source] ${CONTENT_SOURCE_ENV} 取值非法：${JSON.stringify(value)}；` +
      `允许值：${CONTENT_SOURCE_KINDS.join(" / ")}（不设置则为 ${DEFAULT_CONTENT_SOURCE}）。`,
  );
}

/** 进程内缓存：工厂只创建一个实例，避免重复建连接。 */
let cachedSource: Promise<ContentSource> | undefined;

async function createContentSource(kind: ContentSourceKind): Promise<ContentSource> {
  if (kind === "db") {
    // 惰性加载：markdown 模式不会把 postgres / drizzle 打进模块图。
    const { createDbContentSource } = await import("./sources/db");
    return createDbContentSource();
  }

  const { createMarkdownContentSource } = await import("./sources/markdown");
  return createMarkdownContentSource();
}

/**
 * 拿到当前内容源（进程内单例）。
 *
 * 用法：
 * ```ts
 * const source = await getContentSource();
 * const posts = await source.getAllPosts();
 * ```
 */
export function getContentSource(): Promise<ContentSource> {
  cachedSource ??= createContentSource(
    resolveContentSourceKind(process.env[CONTENT_SOURCE_ENV]),
  );
  return cachedSource;
}

/**
 * 清空单例缓存。
 *
 * 只给测试与热重载用：改了 `CONTENT_SOURCE` 之后必须清一次才能生效。
 */
export function resetContentSource(): void {
  cachedSource = undefined;
}
