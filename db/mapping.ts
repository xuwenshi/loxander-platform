/**
 * markdown 文件 → `entries` 行 的**纯函数**映射。
 *
 * 设计约束（与 lead 拍板的映射契约一致，勿擅自改动）：
 * - `kind` 用复数（blog / diary / projects / goals），与 content-core 的 `ENTRY_KINDS` 同源。
 * - 字段名差异在这里就地抹平：blog/diary/goals 取 `title`，projects 取 `name`；
 *   blog/projects 取 `description`，diary 取 `summary`，goals 为空串。
 * - `data` jsonb 的键名与 content-core schema **完全一致**，只剔除「已提升为列」的字段。
 * - `published_at`：blog/diary 取 frontmatter `date` 的**东八区零点**；
 *   projects/goals 没有日期字段，取导入时刻。`display_date` 只给 blog/diary。
 * - `readingTime` **不入库**（读时按 body_md 重算），这里不产生该键。
 * - `body_html` 不在这里生成：本模块保持同步纯函数，渲染交给 `db/import.ts`。
 *
 * 本文件不碰网络、不碰 DATABASE_URL，可被单元测试直接调用。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import matter from 'gray-matter';

import {
  isEntryKind,
  isValidSlug,
  parseEntry,
  type EntryKind,
  type ValidationIssue,
} from '@loxander/content-core';

/* -------------------------------------------------------------------------- */
/* 公开类型                                                                    */
/* -------------------------------------------------------------------------- */

/** P2 导入只产生这两个发布状态；scheduled / archived 留给 P4。 */
export const IMPORTED_PUBLISH_STATUSES = ['draft', 'published'] as const;
export type ImportedPublishStatus = (typeof IMPORTED_PUBLISH_STATUSES)[number];

/**
 * 映射后的 entries 行（不含 `body_html`，也不含 id / created_at 等库端默认值）。
 *
 * 字段集合是 `db/schema.ts` 里 `entries` 表的可写子集。
 */
export interface MappedEntry {
  kind: EntryKind;
  slug: string;
  title: string;
  summary: string;
  body_md: string;
  publish_status: ImportedPublishStatus;
  featured: boolean;
  sort_order: number;
  published_at: Date | null;
  display_date: string | null;
  data: Record<string, unknown>;
  version: number;
}

/** 完整行：映射结果 + 渲染缓存。 */
export interface MappedRow extends MappedEntry {
  body_html: string;
}

/** 映射所需的外部信息。全部显式传入，便于测试，也让「纯函数」名副其实。 */
export interface MapContext {
  /** `apps/web/public` 的绝对路径，用于解析封面 SVG 尺寸。 */
  publicDir: string;
  /** 已知 blog slug，用于 `projects.article` 的引用完整性 warning。 */
  knownBlogSlugs?: readonly string[];
  /** projects/goals 的 published_at 取值来源，默认 `() => new Date()`。 */
  now?: () => Date;
}

/** 映射成功。`warnings` 不阻断，但必须打印出来。 */
export interface MapEntrySuccess {
  ok: true;
  row: MappedEntry;
  warnings: ValidationIssue[];
  /** gray-matter 解析出的正文（已去掉 frontmatter），供调用方渲染。 */
  body: string;
  /**
   * 该条内容的标签，**不属于 `entries` 行**，要写进 `tags` + `entry_tags` 两张表。
   *
   * 顺序 = frontmatter `tags` 数组原序，下标即 `entry_tags.tag_order`。
   * 只有 blog / diary 有值（content-core 里只有这两个 schema 声明了 `tags: zStringSet`），
   * projects / goals 恒为 `[]`。
   *
   * 归一化口径与 `packages/content-core/src/primitives.ts:90-100` 的 `zStringSet`
   * 完全一致（trim / 去空串 / 去重保序）—— 这里再走一遍是因为 `parseEntry` 之后
   * `entry.tags` 已经过 schema 变换，本文件只是把它取出来，不再二次加工。
   */
  tags: string[];
}

/** 映射失败（blocking 非空）。调用方应跳过该文件并汇总。 */
export interface MapEntryFailure {
  ok: false;
  issues: ValidationIssue[];
}

export type MapEntryResult = MapEntrySuccess | MapEntryFailure;

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 东八区偏移。落库前必须显式带时区，否则 Vercel（UTC）上会退一天。
 *
 * 导出供 `db/compare.ts` 复用：它要独立拼出「markdown 路」的 published_at 来比对，
 * 两边一旦各写一份字面量，时区口径就可能悄悄分叉。
 */
export const EAST8_SUFFIX = 'T00:00:00+08:00';

/**
 * 默认排序值，与 schema 的列默认一致。
 *
 * blog/diary 的固定排序值：这两类没有 order 字段，`sort_order` 恒为 999。
 * 导出供 `db/compare.ts` 与导入器共用 —— compare 侧若硬编码 999，
 * 这里一改就会产生假差异。
 */
export const DEFAULT_SORT_ORDER = 999;

/** 未提供 order 时的兜底（content-core 的 zOrder 已给了 999，这里只是防御）。 */
const FALLBACK_ORDER = 999;

/** cover 约定：以 / 开头、以 .svg 结尾（与 content-core parse.ts:58 一致）。 */
const COVER_PATTERN = /^\/.*\.svg$/;

/* -------------------------------------------------------------------------- */
/* 封面尺寸                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 从 `public/` 下的 SVG 读原始宽高。
 *
 * **逐字照抄** `apps/web/src/lib/posts.ts:54-79` 的 `readCoverDimensions`：
 * 先找 `<svg>` 开标签上的 width/height，没有就退回 viewBox 的第三、四个数字。
 * 之所以不抽到共享包：站点那份依赖 `process.cwd()`，而导入脚本在仓库根运行，
 * 两边 cwd 不同（站点是 `apps/web`，这里是仓库根），强行合并会埋坑。
 *
 * 解析不到就返回 `null`，调用方据此**不写** coverWidth / coverHeight。
 */
export function readCoverDimensions(
  publicDir: string,
  cover: string | undefined,
): { width: number; height: number } | null {
  if (!cover || !COVER_PATTERN.test(cover)) return null;

  // cover 形如 `/images/x.svg`，join 前去掉开头斜杠，否则会脱离 publicDir。
  const filePath = join(publicDir, cover.replace(/^\//, ''));
  if (!existsSync(filePath)) return null;

  // 只读开头一段：<svg> 开标签一定在最前面，没必要读整个文件
  const head = readFileSync(filePath, 'utf8').slice(0, 2000);
  const svgTag = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!svgTag) return null;

  const width = /width="([\d.]+)"/.exec(svgTag)?.[1];
  const height = /height="([\d.]+)"/.exec(svgTag)?.[1];
  if (width && height) {
    return { width: Number(width), height: Number(height) };
  }

  const viewBox = /viewBox="([^"]+)"/.exec(svgTag)?.[1]?.trim().split(/\s+/);
  if (viewBox && viewBox.length === 4) {
    return { width: Number(viewBox[2]), height: Number(viewBox[3]) };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

/** 只把「有值」的可选字段写进 data，避免 jsonb 里出现 null / undefined 键。 */
function putIfPresent(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && value === '') return;
  target[key] = value;
}

/** 东八区零点。blog/diary 的 `date` 已由 content-core 归一成 YYYY-MM-DD。 */
function east8Midnight(date: string, file: string): Date {
  const value = new Date(`${date}${EAST8_SUFFIX}`);
  if (Number.isNaN(value.getTime())) {
    // 理论上走不到：zDate 已保证格式。留一道防线，避免静默写入 Invalid Date。
    throw new Error(`[${file}] 无法把日期解析成东八区零点：${date}`);
  }
  return value;
}

/** 只有 blog / diary 的 schema 声明了 `draft`；projects / goals 没有这个字段。 */
function readDraftFlag(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  return (entry as { draft?: unknown }).draft === true;
}

/**
 * 取出该条内容的标签（**顺序即 frontmatter 数组原序**，下标就是 `tag_order`）。
 *
 * 归一化（trim / 去空串 / 去重保序）已经由 content-core 的 `zStringSet`
 * （`packages/content-core/src/primitives.ts:90-100`）在 `parseEntry` 里做过，
 * 这里**不再重复一遍**：重复实现两份归一化，早晚会因为「先 trim 还是先去重」
 * 这类顺序差异产生分叉，而这里恰好是 `tag_order` 的来源。
 *
 * 仍然做一次宽松的类型收窄：schema 之外的东西（比如 `tags: 42`）在
 * `parseEntry` 阶段已经被 blocking，走到这里基本只会是 `string[]` 或 `undefined`。
 * 只有 blog / diary 声明了 tags，projects / goals 走 `?? []` 分支。
 */
function readTags(entry: Record<string, unknown>): string[] {
  const value = entry.tags;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/* -------------------------------------------------------------------------- */
/* 主映射                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 把一份 markdown 原文映射成 entries 行。
 *
 * 纯函数：同样的 `(kind, slug, raw, ctx)` 必然得到同样的行（`now` 可注入）。
 * 不会写库、不读环境变量。
 *
 * @param kind    内容分区
 * @param slug    文件名去掉 `.md`
 * @param raw     文件全文（含 frontmatter）
 * @param ctx     封面目录 / 已知 blog slug / 时间源
 */
export function mapEntry(
  kind: EntryKind,
  slug: string,
  raw: string,
  ctx: MapContext,
): MapEntryResult {
  const file = `${kind}/${slug}.md`;

  if (!isEntryKind(kind)) {
    return {
      ok: false,
      issues: [
        {
          level: 'block',
          message: `未知内容分区：${String(kind)}`,
          hint: '允许值：blog / diary / projects / goals',
        },
      ],
    };
  }

  // slug 来自文件名，不走 parseEntry，单独校验（复用 content-core 的 SAFE_SLUG）。
  if (!isValidSlug(slug)) {
    return {
      ok: false,
      issues: [
        {
          level: 'block',
          field: 'slug',
          message: `非法 slug：${slug}`,
          hint: '仅允许字母、数字、点、下划线、连字符，且不能是 . 或 ..',
        },
      ],
    };
  }

  const parsed = matter(raw);
  const frontmatter = parsed.data as Record<string, unknown>;
  const body = parsed.content;

  // 引用完整性：只传能提供的外部信息，parseEntry 据此产出 warning（不阻断）。
  const result = parseEntry(kind, frontmatter, {
    knownBlogSlugs: ctx.knownBlogSlugs,
    publicFileExists: (relativePath) =>
      existsSync(join(ctx.publicDir, relativePath.replace(/^\//, ''))),
  });

  if (result.blocking.length > 0 || !result.data) {
    return { ok: false, issues: result.blocking };
  }

  const now = ctx.now ?? (() => new Date());
  const entry = result.data as Record<string, unknown>;

  // 正文归一：gray-matter 保留 frontmatter 之后的空行，导致 body_md 以 `\n` 开头。
  // 站点侧一直原样使用 content（`apps/web/src/lib/posts.ts:105` 的 `const { data, content } = matter(raw)`，
  // 第 131 行 `return { meta, body: content }` 未 trim），渲染器能容忍；
  // 但落库后这份前导空行会变成每一行的稳定脏数据（且影响去重比较）。
  // 因此这里统一 trim，并与 `db/compare.ts:297` 的 `content.trim()` 保持同一口径，
  // 保证 body_md 的「markdown 路 vs db 路」逐字符可比。
  const bodyText = body.trim();
  if (bodyText === '') {
    return {
      ok: false,
      issues: [
        { level: 'block', field: 'body_md', message: '正文为空（frontmatter 之后没有内容）' },
      ],
    };
  }

  let row: MappedEntry;

  // 标签是**行级旁挂数据**，不进 `entries.data`（见 `DROPPED_FRONTMATTER_FIELDS`）：
  // 它们要落到 `tags` + `entry_tags` 两张表，读路径靠 join 还原。
  // 顺序在这里就必须定死 —— 调用方（`db/import.ts`）直接用数组下标当 `tag_order`。
  const tags = readTags(entry);

  switch (kind) {
    case 'blog': {
      const data: Record<string, unknown> = {
        category: entry.category as string,
      };
      putIfPresent(data, 'cover', entry.cover);
      const dims = readCoverDimensions(ctx.publicDir, entry.cover as string | undefined);
      if (dims) {
        data.coverWidth = dims.width;
        data.coverHeight = dims.height;
      }
      const date = entry.date as string;
      row = {
        kind,
        slug,
        title: entry.title as string,
        summary: entry.description as string,
        body_md: bodyText,
        publish_status: readDraftFlag(entry) ? 'draft' : 'published',
        featured: false,
        sort_order: DEFAULT_SORT_ORDER,
        published_at: east8Midnight(date, file),
        display_date: date,
        data,
        version: 1,
      };
      break;
    }

    case 'diary': {
      // 只留 `{ mood? }`。`date` 已提升为 `entries.display_date` 列，同一事实不再存两份
      // —— 否则 P4 后台改日期时 jsonb 与列必然漂移。
      const data: Record<string, unknown> = {};
      putIfPresent(data, 'mood', entry.mood);
      const date = entry.date as string;
      row = {
        kind,
        slug,
        title: entry.title as string,
        // diary 用 summary，不是 description。
        summary: entry.summary as string,
        body_md: bodyText,
        publish_status: readDraftFlag(entry) ? 'draft' : 'published',
        featured: false,
        sort_order: DEFAULT_SORT_ORDER,
        published_at: east8Midnight(date, file),
        display_date: date,
        data,
        version: 1,
      };
      break;
    }

    case 'projects': {
      const data: Record<string, unknown> = {
        techStack: entry.techStack as string[],
        status: entry.status as string,
      };
      putIfPresent(data, 'period', entry.period);
      putIfPresent(data, 'role', entry.role);
      putIfPresent(data, 'github', entry.github);
      putIfPresent(data, 'demo', entry.demo);
      putIfPresent(data, 'article', entry.article);
      row = {
        kind,
        slug,
        // projects 用 name，不是 title。
        title: entry.name as string,
        summary: entry.description as string,
        body_md: bodyText,
        // projects/goals 的 content-core schema 未声明 draft（仅 blog.ts:29 / diary.ts:30 有），
        // 故这两类恒为 published；要在 P4 支持项目草稿，须先给两个 schema 加 draft。
        publish_status: 'published',
        featured: entry.featured === true,
        sort_order: typeof entry.order === 'number' ? entry.order : FALLBACK_ORDER,
        published_at: now(),
        display_date: null,
        data,
        version: 1,
      };
      break;
    }

    case 'goals': {
      const data: Record<string, unknown> = {
        horizon: entry.horizon as string,
        status: entry.status as string,
        progress: entry.progress as number,
        milestones: entry.milestones as { title: string; done: boolean }[],
      };
      putIfPresent(data, 'period', entry.period);
      row = {
        kind,
        slug,
        title: entry.title as string,
        // goals 没有摘要字段，列 notNull 且默认 ''，写空串。
        summary: '',
        body_md: bodyText,
        // projects/goals 的 content-core schema 未声明 draft（仅 blog.ts:29 / diary.ts:30 有），
        // 故这两类恒为 published；要在 P4 支持项目草稿，须先给两个 schema 加 draft。
        publish_status: 'published',
        featured: false,
        sort_order: typeof entry.order === 'number' ? entry.order : FALLBACK_ORDER,
        published_at: now(),
        display_date: null,
        data,
        version: 1,
      };
      break;
    }
  }

  return { ok: true, row, warnings: result.warnings, body: bodyText, tags };
}

/* -------------------------------------------------------------------------- */
/* 站点渲染选项对齐（body_html 的唯一真源）                                      */
/* -------------------------------------------------------------------------- */

/**
 * 各类内容在**站点上**渲染 `body_html` 时使用的选项。
 *
 * 为什么放在这里、而不是各写一套：
 *   `body_md` / `data` 已经在这里定型，渲染选项是同一套「markdown → 库行」契约的一部分。
 *   放进一个纯函数，`db/import.ts` 与 `db/mapping.test.ts` 共用，改一处不会漏另一处。
 *
 * 只有 goals 有差异，其余三类都是 0；调用方仍然统一走本函数，避免上游写 `kind === 'goals'` 分支。
 *
 * ⚠️ 与 `apps/web/src/lib/goals.ts:88` 的 `renderMarkdown(body, { headingOffset: 2 })`
 *    **逐字节对齐**：站点把目标正文嵌在卡片里（分组 h2 → 卡片标题 h3），正文的 `##`
 *    必须降到 h4，否则大纲会倒挂。改任意一处必须同步改另一处，
 *    由 `db/compare.ts` 的维度 5（body_html 逐字节）守护。
 */
export function renderOptionsForKind(kind: EntryKind): { headingOffset: number } {
  return kind === 'goals' ? { headingOffset: 2 } : { headingOffset: 0 };
}

/* -------------------------------------------------------------------------- */
/* 标签 slug 规则                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 标签名 → `tags.slug`。
 *
 * 规则：**直接用 tag name 原文**（中文就是中文）。
 *
 * 为什么不做 slugify：
 * - 全仓没有任何 slugify 工具（`packages/content-core` 的 `zSlug` 只用于内容 slug，
 *   正则 `SAFE_SLUG` 只允许字母数字点下划线连字符，中文 tag 会被它直接判非法）；
 * - 目前**没有任何 `/tags` 路由、也没有任何 URL 消费 slug**。实测
 *   `apps/web/src/app/**` 下 11 个 `page.tsx` 里没有 tags 目录；
 *   `getAllTags()` 唯一的消费方是 `sources/__tests__/content-source.test.ts`，
 *   站点页面根本不调用它。既然没有消费方，引入一套转写/去重规则只会在将来
 *   真正需要时成为兼容负担。
 *
 * 所以 `slug` 与 `name` 当前恒等；两者分开存是为了将来 URL 安全化时**只改这一个函数**
 * （届时同时要处理历史数据的回填，属于 P3/P4 的事）。
 *
 * 用 name 做唯一键的副作用：大小写/全半角不同的标签会被当成不同标签
 * （`"RAG"` 与 `"rag"` 是两条）。这与站点侧 `getAllTags()` 的 `Map` 计数口径一致
 * （那里也是按原字符串去重，见 `apps/web/src/lib/posts.ts:210-222`），
 * 因此不会产生两路差异。
 */
export function tagSlugOf(name: string): string {
  return name;
}

/* -------------------------------------------------------------------------- */
/* 未入库字段的显式清单（供报告使用）                                           */
/* -------------------------------------------------------------------------- */

/**
 * frontmatter 里存在、但**没有**进入 `entries` 行的字段。
 *
 * 不是遗漏，是契约结果：
 * - `tags`：**不在 `entries.data` 里，但也不是"被丢弃"** —— 它迁移到
 *   `tags` / `entry_tags` 两张表（P2 补齐，含 `tag_order` 保序）。`mapEntry` 用返回值的
 *   `tags: string[]` 旁挂带出（数组下标即 `tag_order`），由 `db/import.ts` 的
 *   `writeTagRelations` 写入关系表。列在这里是提醒审核者：`entries` 行里没有它们，
 *   要用得去 join `entry_tags`。
 * - `readingTime`：读时按 `body_md` 重算。
 */
export const DROPPED_FRONTMATTER_FIELDS: Readonly<Record<EntryKind, readonly string[]>> = {
  blog: ['tags'],
  diary: ['tags'],
  projects: [],
  goals: [],
};
