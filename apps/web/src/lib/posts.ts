import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { extractHeadings, renderMarkdown } from "@loxander/markdown";

import { contentDir, publicPath } from "./app-root";
import { parseOrThrow } from "./parse-entry";
import type { SearchDoc } from "./search";
import { tagMatches } from "./tag-url";
import type { Post, PostMeta, TagCount } from "@/types";

/**
 * 文章内容读取（content/blog/*.md）。
 *
 * P1 起 frontmatter 校验与 Markdown 渲染都交给共享包：
 * - `@loxander/content-core`：四类内容共用的 Zod schema（web 与 desktop 同一份契约）
 * - `@loxander/markdown`：渲染管线（含 Shiki 高亮与 TOC 提取）
 *
 * 本文件只保留站点独有的两件事：
 * - 从本地 SVG 封面读出原始宽高（用于 <img> 预留空间，避免 CLS）
 * - 估算阅读时间
 */

/**
 * 内容目录。**不要改回 `path.join(process.cwd(), "content", "blog")`**：
 * 生产启动时 cwd 是仓库根而不是 `apps/web`，那样会读不到任何文章
 * （详见 `lib/app-root.ts` 文件头记录的实测证据）。
 */
const BLOG_DIR = contentDir("blog");

/** 生产构建时隐藏 draft: true 的文章 */
const includeDrafts = process.env.NODE_ENV !== "production";

/** cover 约定：以 / 开头、以 .svg 结尾（与 content-core 的引用完整性检查一致） */
const COVER_PATTERN = /^\/.*\.svg$/;

function listPostFiles(): string[] {
  if (!fs.existsSync(BLOG_DIR)) return [];
  return fs
    .readdirSync(BLOG_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort();
}

/** 已知的 blog slug，用于校验 projects.article 的引用完整性 */
export function getBlogSlugs(): string[] {
  return listPostFiles().map((file) => file.replace(/\.md$/, ""));
}

/**
 * 读取本地 SVG 封面的原始尺寸，用来给 <img> 补上 width / height 属性。
 *
 * 为什么要多这一步：`<img>` 只有 CSS 宽度、没有宽高属性时，浏览器在图片
 * 下载完成前不知道它的高宽比，会先按 0 高度排版、等图片到达后再撑开，
 * 造成明显的 CLS（布局偏移）。有了宽高属性，浏览器可以立刻按比例预留空间。
 *
 * 只处理 SVG：它本身就是文本，解析 `<svg>` 开标签即可拿到 width/height 或
 * viewBox；位图需要读二进制头（PNG/JPEG 各不相同），收益有限，暂不处理 ——
 * 解析不到就返回 null，`<img>` 退回原来的行为，不会出错。
 */
function readCoverDimensions(
  cover: string | undefined,
): { width: number; height: number } | null {
  if (!cover || !COVER_PATTERN.test(cover)) return null;

  const filePath = publicPath(cover);
  if (!fs.existsSync(filePath)) return null;

  // 只读开头一段：<svg> 开标签一定在最前面，没必要读整个文件
  const head = fs.readFileSync(filePath, "utf8").slice(0, 2000);
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

/**
 * 估算阅读时间（分钟）。
 * 中文按 350 字/分钟、英文按 200 词/分钟计算，并对代码块做一定折扣。
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

type ParsedPost = {
  meta: PostMeta;
  body: string;
};

/** 解析单个文章文件（未渲染 HTML），列表页只需元信息 */
function parsePostFile(file: string): ParsedPost {
  const slug = file.replace(/\.md$/, "");
  const raw = fs.readFileSync(path.join(BLOG_DIR, file), "utf8");
  const { data, content } = matter(raw);

  // 校验交给 content-core：字段归一（trim / tags 去重 / 日期双分支）都在那里，
  // 这里拿到的已经是可直接渲染的强类型对象。
  const entry = parseOrThrow("blog", data, file, {
    publicFileExists: (relativePath) => fs.existsSync(publicPath(relativePath)),
  });

  const coverDimensions = readCoverDimensions(entry.cover);

  const meta: PostMeta = {
    slug,
    title: entry.title,
    description: entry.description,
    date: entry.date,
    tags: entry.tags,
    category: entry.category,
    cover: entry.cover,
    ...(coverDimensions
      ? { coverWidth: coverDimensions.width, coverHeight: coverDimensions.height }
      : {}),
    draft: entry.draft,
    readingTime: estimateReadingTime(content),
  };

  return { meta, body: content };
}

function readAllParsedPosts(): ParsedPost[] {
  return listPostFiles()
    .map(parsePostFile)
    .filter((post) => includeDrafts || !post.meta.draft);
}

/** 全部文章元信息，按日期倒序（新文章在前） */
export function getAllPosts(): PostMeta[] {
  return readAllParsedPosts()
    .map((post) => post.meta)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** 首页 / 侧栏使用的精选文章 */
export function getRecentPosts(limit = 3): PostMeta[] {
  return getAllPosts().slice(0, limit);
}

/**
 * 单篇文章（含渲染后的 HTML 与目录）。
 *
 * 标记 `use cache` 有两个原因：
 * 1. 代码高亮是这里最重的计算，按 slug 缓存后列表 / 详情 / 元数据只算一次；
 * 2. Shiki 底层的 vscode-textmate 在分词时会读取 `Date.now()`（用于超时保护），
 *    在 Cache Components 模式下这属于「不稳定值」，必须放进缓存作用域里。
 */
export async function getPost(slug: string): Promise<Post | null> {
  "use cache";

  const parsed = readAllParsedPosts().find((post) => post.meta.slug === slug);
  if (!parsed) return null;

  const [html, headings] = await Promise.all([
    renderMarkdown(parsed.body),
    Promise.resolve(extractHeadings(parsed.body)),
  ]);

  return { ...parsed.meta, html, headings };
}

/** 上一篇 / 下一篇（按时间顺序，新文章在前） */
export function getAdjacentPosts(slug: string): {
  prev: PostMeta | null;
  next: PostMeta | null;
} {
  const posts = getAllPosts();
  const index = posts.findIndex((post) => post.slug === slug);
  if (index === -1) return { prev: null, next: null };

  return {
    // 列表是倒序的：index - 1 更新，index + 1 更旧
    prev: index > 0 ? posts[index - 1] : null,
    next: index < posts.length - 1 ? posts[index + 1] : null,
  };
}

/** 相关文章：优先标签重合，其次同分类 */
export function getRelatedPosts(slug: string, limit = 3): PostMeta[] {
  const posts = getAllPosts();
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
}

/** 全部标签及数量，按数量倒序 */
export function getAllTags(): TagCount[] {
  const counter = new Map<string, number>();

  for (const post of getAllPosts()) {
    for (const tag of post.tags) {
      counter.set(tag, (counter.get(tag) ?? 0) + 1);
    }
  }

  return [...counter.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** 全部分类及数量 */
export function getAllCategories(): TagCount[] {
  const counter = new Map<string, number>();

  for (const post of getAllPosts()) {
    counter.set(post.category, (counter.get(post.category) ?? 0) + 1);
  }

  return [...counter.entries()]
    .map(([category, count]) => ({ tag: category, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/* -------------------------------------------------------------------------- */
/* P5 新增：标签页与服务端搜索                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 某个标签下的全部文章。
 *
 * 输入是**路由参数**（`/tags/[tag]` 的原始段），不是标签名原文 ——
 * 归一化（小写、`+` 当空格、畸形编码兜底）全部交给 `lib/tag-url.ts` 的
 * `tagMatches()`，这个文件里不再出现第二套规则。
 *
 * 匹配口径与 `getAllTags()` 的计数口径**刻意不同**：
 * - `getAllTags()` 用精确字符串去重（`"RAG"` 与 `"rag"` 是两个标签，如实呈现）；
 * - 这里大小写不敏感（`/tags/RAG` 与 `/tags/rag` 是同一个页面，URL 才稳定）。
 *
 * 两个需求本来就冲突：前者要「如实」，后者要「稳定」。
 * 解法是把归一化限制在 URL 边界，标签本身的存储与展示仍是原样 ——
 * 所以 `/tags/rag` 会把带 `"RAG"` 标签的文章也列出来，而标签胶囊上显示的仍是 `"RAG"`。
 *
 * 空标签返回 `[]`（不抛错），由页面决定 404 还是空状态。
 */
export function getPostsByTag(tag: string): PostMeta[] {
  return getAllPosts().filter((post) =>
    post.tags.some((name) => tagMatches(name, tag)),
  );
}

/**
 * 搜索候选全集（含正文原文）。
 *
 * 为什么单独一个函数、而不是让 `searchDocs()` 自己调 `getAllPosts()`：
 * 搜索按「标题 / 标签 / 分类 / 摘要 / 正文」五个字段打分，
 * 其中只有正文需要**额外读一遍文件**。把读取集中在这里，
 * 才能让 `sources/db.ts` 用同构方式提供候选（它那边正文就是 `body_md` 列，
 * 已经在 `loadRows` 的结果里，不需要额外查询）。
 *
 * 返回的 `body` 是 frontmatter 之后的 `content`（未渲染、未 trim），
 * 与 `estimateReadingTime(content)` 用的是同一份输入。
 */
export function getSearchDocs(): SearchDoc[] {
  return readAllParsedPosts().map((post) => ({ ...post.meta, body: post.body }));
}
