/**
 * 站内搜索的**唯一语义实现**（纯函数，无任何 I/O）。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────
 * `ContentSource` 现在有两个实现（`sources/markdown.ts` / `sources/db.ts`），
 * 两者被 `content-source.test.ts` 逐条 `assert.deepEqual` 比对。
 * 「什么算命中」「命中怎么排序」如果各写一份，两边必然会漂移 ——
 * 而这种漂移在线下测试里只表现为「两条结果顺序不同」，很容易被当成测试抖动忽略掉。
 *
 * 所以匹配与排序**只在这里实现一次**，两个内容源都调它：
 * - markdown 源：从文件读出 `SearchDoc`（含正文原文）；
 * - db 源：从 `entries` 表读出 `SearchDoc`（`body` 取 `body_md`）。
 * 两边唯一可能不同的地方只是「候选集合」与「正文从哪来」，语义完全一致。
 *
 * ── 搜索范围 ─────────────────────────────────────────────────────────
 * **只搜文章（blog）**，与 `getAllTags()` / `getAllCategories()` 同范围。
 * 理由：标签与分类本来就是 blog 独有的字段，`projects` / `goals` 没有
 * `category` / `tags`，硬塞进来就要为「哪个字段算正文」做按 kind 的分支，
 * 而分出来的每一支都是新的漂移风险。范围写死在这里，UI 上也照实说。
 *
 * ── 只返回已发布内容 ─────────────────────────────────────────────────
 * 本文件**不做**草稿过滤 —— 它拿到的 `docs` 就是候选全集。
 * 「只返回已发布」由两个实现保证：markdown 源的 `getAllPosts()` 已经过滤
 * `draft: true`，db 源的 `loadRows("blog")` 已经在生产环境套 `visibleOnly()`。
 * 把过滤放在这里反而会掩盖「某个实现忘了过滤」这类错误 ——
 * `p5-wiring.test.ts` 专门有一条用例守这个边界。
 */

import type { PostMeta } from "@/types";

/** 查询串最大长度。超过直接判为不可搜索，避免把整篇文章粘进地址栏。 */
export const SEARCH_MAX_QUERY_LENGTH = 80;

/** 最多取多少个词参与 AND 匹配。多于此数只取前 N 个，防止构造超长查询拖慢请求。 */
export const SEARCH_MAX_TOKENS = 8;

/** 命中的字段。顺序即「权重从高到低」，`matchedIn` 也按这个顺序输出。 */
export type SearchField = "title" | "tags" | "category" | "description" | "body";

/**
 * 字段权重。
 *
 * 权重是「一个词命中这个字段值多少分」，不是排序主键 ——
 * 多个词命中的分数会累加，所以「标题里出现两个词」仍然胜过「正文里出现一个词」。
 * 数值刻意保持整数，避免浮点比较在不同引擎上的末位差异。
 */
export const SEARCH_FIELD_WEIGHTS: Record<SearchField, number> = {
  title: 5,
  tags: 4,
  category: 3,
  description: 2,
  body: 1,
};

/** 结果页展示「命中位置」用的中文标签。 */
export const SEARCH_FIELD_LABELS: Record<SearchField, string> = {
  title: "标题",
  tags: "标签",
  category: "分类",
  description: "摘要",
  body: "正文",
};

/** 权重从高到低的字段顺序（`matchedIn` 与 UI 展示都按它走）。 */
export const SEARCH_FIELD_ORDER: readonly SearchField[] = [
  "title",
  "tags",
  "category",
  "description",
  "body",
];

/**
 * 参与匹配的文档。
 *
 * `body` 是**正文原文**（Markdown 源码，未渲染、未 strip 标记）。
 * 不做 Markdown 清洗是有意为之：清洗需要引入一套规则，而那套规则又会成为
 * 「markdown 源与 db 源要不要一致」的新考题；而搜索一个技术博客时，
 * 代码块里的标识符恰恰是最有价值的命中来源，剥掉反而是损失。
 */
export interface SearchDoc extends PostMeta {
  /** 正文原文（Markdown）。只用于匹配，**不会**出现在返回值里。 */
  body: string;
}

/**
 * 归一化查询串：去首尾空白、把连续空白折成一个、转小写。
 *
 * 全角空格也当分隔符 —— 中文输入法下很容易打出 `\u3000`，
 * 不处理的话 `机器　学习` 会变成一个含全角空格的词，永远匹配不到东西。
 */
export function normalizeQuery(raw: string): string {
  return raw.replace(/[\s\u3000]+/g, " ").trim().toLowerCase();
}

/**
 * 切词：按空白切成若干词，去重并保持出现顺序，最多 {@link SEARCH_MAX_TOKENS} 个。
 *
 * **不引入分词库**：中文没有空格，任何「智能分词」都会带来
 * 「这个词算不算一个词」的主观判定，而搜索的可预期性比聪明更重要。
 * 中文查询通常整句粘在一起（`rag 分块` 这种混排就自然切成两个词），
 * 走的是子串包含，符合「我输入什么就得包含什么」的直觉。
 */
export function tokenizeQuery(raw: string): string[] {
  const normalized = normalizeQuery(raw);
  if (!normalized) return [];

  const tokens: string[] = [];
  for (const token of normalized.split(" ")) {
    if (!token) continue;
    if (tokens.includes(token)) continue;
    tokens.push(token);
    if (tokens.length >= SEARCH_MAX_TOKENS) break;
  }
  return tokens;
}

/**
 * 查询是否值得执行。
 *
 * 判据：归一化后非空、长度不超过 {@link SEARCH_MAX_QUERY_LENGTH}、
 * 且至少切出一个词。空查询返回 `false`，页面据此渲染「请输入关键词」
 * 而不是渲染「0 条结果」—— 后者会让人以为站里什么都没有。
 */
export function isSearchableQuery(raw: string): boolean {
  const normalized = normalizeQuery(raw);
  if (!normalized) return false;
  if (normalized.length > SEARCH_MAX_QUERY_LENGTH) return false;
  return tokenizeQuery(normalized).length > 0;
}

/** 取一个字段参与匹配的文本。数组（tags）拼成空格分隔串，null/undefined 当空串。 */
function fieldText(doc: SearchDoc, field: SearchField): string {
  switch (field) {
    case "title":
      return doc.title;
    case "tags":
      return doc.tags.join(" ");
    case "category":
      return doc.category;
    case "description":
      return doc.description;
    case "body":
      return doc.body;
  }
}

/**
 * 判断一篇文档是否命中全部词（AND 语义），返回命中字段列表。
 *
 * - 每个词都必须至少在一个字段里出现，否则整篇不命中；
 * - 一个词出现在多个字段里时，**只按权重最高的那个字段计分**（见 {@link scoreDoc}），
 *   避免「标题命中」被「正文也命中」稀释成同一个分数；
 * - 返回值按 {@link SEARCH_FIELD_ORDER} 排序，且只包含**至少一个词命中的字段**。
 *
 * 大小写不敏感：匹配前对字段文本做 `toLowerCase()`。
 * 中文没有大小写，这一步只影响英文标签与技术名词（`RAG` / `rag`）。
 */
export function matchDoc(doc: SearchDoc, tokens: readonly string[]): SearchField[] | null {
  if (tokens.length === 0) return null;

  const matched = new Set<SearchField>();

  for (const token of tokens) {
    let hit = false;
    for (const field of SEARCH_FIELD_ORDER) {
      if (fieldText(doc, field).toLowerCase().includes(token)) {
        hit = true;
        matched.add(field);
      }
    }
    if (!hit) return null;
  }

  return SEARCH_FIELD_ORDER.filter((field) => matched.has(field));
}

/**
 * 计算文档得分。
 *
 * 对每个词，取它命中字段里的**最高权重**累加。
 * 例：查询 `rag 分块`，`rag` 命中标题（5）与正文（1）→ 取 5；
 * `分块` 只命中正文（1）→ 取 1；总分 6。
 */
export function scoreDoc(doc: SearchDoc, tokens: readonly string[]): number {
  let score = 0;

  for (const token of tokens) {
    let best = 0;
    for (const field of SEARCH_FIELD_ORDER) {
      if (SEARCH_FIELD_WEIGHTS[field] <= best) continue;
      if (fieldText(doc, field).toLowerCase().includes(token)) {
        best = SEARCH_FIELD_WEIGHTS[field];
      }
    }
    score += best;
  }

  return score;
}

/** 把 `SearchDoc` 裁成对外的 `PostMeta`，**丢掉正文**，避免整篇文章进 RSC payload。 */
function toPostMeta(doc: SearchDoc): PostMeta {
  return {
    slug: doc.slug,
    title: doc.title,
    description: doc.description,
    date: doc.date,
    tags: doc.tags,
    category: doc.category,
    ...(doc.cover === undefined ? {} : { cover: doc.cover }),
    ...(doc.coverWidth === undefined ? {} : { coverWidth: doc.coverWidth }),
    ...(doc.coverHeight === undefined ? {} : { coverHeight: doc.coverHeight }),
    draft: doc.draft,
    readingTime: doc.readingTime,
  };
}

/**
 * 在一个候选集合里执行搜索，返回排序后的 `PostMeta[]`。
 *
 * 排序（全部为全序，结果稳定可预期）：
 * 1. 得分降序；
 * 2. 日期降序（`localeCompare`，与 `getAllPosts()` 同一写法）；
 * 3. slug 码点升序（兜底，保证「得分与日期都相同」的两篇也不会随机换位）。
 *
 * 返回 `PostMeta` 而不是 `SearchDoc`：页面只渲染卡片，正文（可能几十 KB
 * 含代码块）没有任何用处，留着它进 RSC payload 是纯浪费。
 */
export function rankDocs(docs: readonly SearchDoc[], tokens: readonly string[]): PostMeta[] {
  const scored: { doc: SearchDoc; score: number }[] = [];

  for (const doc of docs) {
    if (matchDoc(doc, tokens) === null) continue;
    scored.push({ doc, score: scoreDoc(doc, tokens) });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.doc.date.localeCompare(a.doc.date) ||
      (a.doc.slug < b.doc.slug ? -1 : a.doc.slug > b.doc.slug ? 1 : 0),
  );

  return scored.map((item) => toPostMeta(item.doc));
}

/**
 * 一步到位的搜索：解析查询串 + 过滤 + 排序。
 *
 * 查询不可搜索（空 / 超长 / 全是分隔符）时返回空数组 —— 调用方应该先用
 * {@link isSearchableQuery} 判断，以便区分「没输入」与「没结果」。
 */
export function searchDocs(docs: readonly SearchDoc[], raw: string): PostMeta[] {
  if (!isSearchableQuery(raw)) return [];
  return rankDocs(docs, tokenizeQuery(raw));
}
