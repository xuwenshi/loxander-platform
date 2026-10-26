/**
 * markdown 内容源的「页面是否存在」判定 —— 只读文件系统，不连库。
 *
 * ── 这个文件为什么存在（上一轮漏掉的另一半）─────────────────────────
 * `lib/proxy-rules.ts` 解决了 db 源下的软 404，但 `proxy.ts` 里那行
 * `if (process.env.CONTENT_SOURCE !== "db") return NextResponse.next();`
 * 把整段存在性检查放在 db 分支之后 —— 于是**回滚到 markdown 源时软 404 全回来**。
 *
 * 实测（同一份构建产物，只改运行时 `CONTENT_SOURCE`）：
 * ```
 *                                    mode=markdown      mode=db
 * /blog/nope-blog                    200 ✗ 软 404       404 ✓
 * /diary/nope-diary                  200 ✗ 软 404       404 ✓
 * /projects/nope-project             200 ✗ 软 404       404 ✓
 * /tags/nope-tag                     200 ✗ 软 404       404 ✓
 * /totally-unknown-path              404 ✓              404 ✓
 * ```
 * 而方案 §16.2 明确把 `CONTENT_SOURCE=markdown` 定为**回滚通道**，
 * 一条「出事时用来救火」的通道不该自带一类 SEO 脏数据。
 *
 * ── 为什么不能复用 `lib/posts.ts` 的现成函数 ─────────────────────────
 * `lib/posts.ts` 顶部 `import { extractHeadings, renderMarkdown } from "@loxander/markdown"`
 * —— 那会把 Shiki 与整套 unified 管线拖进 proxy 的模块图。Proxy 每个非静态请求
 * 都要跑一次，为一个 `existsSync` 级别的判断付那份冷启动代价不值得。
 * 所以这里只用 `node:fs` / `node:path` / `gray-matter`（读取 `draft` 字段用）。
 *
 * ── 判据必须与页面层完全一致，否则会出现「proxy 说存在、页面 404」────────
 * - **详情页**：`app/(site)/blog/[slug]/page.tsx` 等用 `getPost(slug)` 判空，
 *   而 `getPost` 走 `readAllParsedPosts()`，它在生产环境下 `.filter(post => !post.meta.draft)`。
 *   所以文件名存在**还不够**，生产环境下 `draft: true` 的文章必须算「不存在」。
 * - **标签页**：`app/(site)/tags/[tag]/page.tsx` 的判据是「这个标签下至少有一篇可见文章」。
 *   标签名来自 frontmatter 的 `tags` 数组（`db/mapping.ts` 的 `tagSlugOf()` 是恒等函数，
 *   库里存的就是原文），URL 段经 `tagSlugOfName()` 归一化（trim + 小写）。
 *   所以这里比对时也要走同一个 `tagSlugOfName`。
 *
 * ── 缓存策略：生产环境进程级记忆化 ───────────────────────────────────
 * markdown 源按设计是**只读快照**（回滚用途，P4 后台只写库）。所以一次进程生命周期内
 * 内容不会变，扫描结果可以直接记在模块作用域。开发环境不缓存 —— 改完 md 要立刻生效。
 * 只有 4 篇 blog，扫描本身是亚毫秒级；缓存主要是为了不每个请求都读一遍 frontmatter。
 */

import fs from "node:fs";
import path from "node:path";

import matter from "gray-matter";

import { contentDir } from "./app-root";
import type { PageProbe } from "./proxy-rules";
import { decodeTagParam, tagSlugOfName } from "./tag-url";

/** 生产环境只在进程启动后扫一次；开发环境每次现算。 */
const MEMOIZE = process.env.NODE_ENV === "production";

/** `content/<kind>` 下的全部 `.md` 文件名（不含扩展名）。空目录返回空数组。 */
function listSlugs(kind: string): string[] {
  const dir = contentDir(kind);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.replace(/\.md$/, ""));
}

/** 读一个 md 的 frontmatter。解析失败按「无 frontmatter」处理，不抛。 */
function frontmatterOf(kind: string, slug: string): Record<string, unknown> {
  const file = path.join(contentDir(kind), `${slug}.md`);
  try {
    const parsed = matter(fs.readFileSync(file, "utf8"));
    return (parsed.data ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** `draft: true` 才算草稿；其它任何值都按「不是草稿」（与 content-core 的 `zBooleanFlag` 一致：只认布尔真）。 */
function isDraft(data: Record<string, unknown>): boolean {
  return data.draft === true;
}

/** 生产环境是否隐藏草稿 —— 与 `lib/posts.ts:28` 的 `includeDrafts` 同一判据。 */
const includeDrafts = process.env.NODE_ENV !== "production";

/* -------------------------------------------------------------------------- */
/* 详情页：/blog/<slug>、/diary/<slug>、/projects/<slug>                       */
/* -------------------------------------------------------------------------- */

let slugIndex: Map<string, Set<string>> | undefined;

function slugsByKind(): Map<string, Set<string>> {
  if (slugIndex !== undefined) return slugIndex;

  const index = new Map<string, Set<string>>();
  for (const kind of ["blog", "diary", "projects"]) {
    const visible = listSlugs(kind).filter((slug) => {
      if (includeDrafts) return true;
      return !isDraft(frontmatterOf(kind, slug));
    });
    index.set(kind, new Set(visible));
  }

  if (MEMOIZE) slugIndex = index;
  return index;
}

/* -------------------------------------------------------------------------- */
/* 标签页：/tags/<tag>                                                         */
/* -------------------------------------------------------------------------- */

let tagIndex: Set<string> | undefined;

/**
 * 全部「有至少一篇可见文章」的标签归一化名集合。
 *
 * 与 `getAllTags()` 的口径一致：只统计 **blog**（`getAllTags()` 遍历的是
 * `getAllPostsCached()` 的 `post.tags`），且只统计可见文章。
 */
function visibleTagSlugs(): Set<string> {
  if (tagIndex !== undefined) return tagIndex;

  const slugs = new Set<string>();
  for (const slug of slugsByKind().get("blog") ?? new Set<string>()) {
    const data = frontmatterOf("blog", slug);
    const tags = data.tags;
    if (!Array.isArray(tags)) continue;
    for (const name of tags) {
      if (typeof name !== "string") continue;
      const normalized = tagSlugOfName(name);
      if (normalized) slugs.add(normalized);
    }
  }

  if (MEMOIZE) tagIndex = slugs;
  return slugs;
}

/* -------------------------------------------------------------------------- */
/* 对外入口                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * markdown 源下这个页面是否存在。
 *
 * 返回值语义与 `proxy.ts` 的 `probePageExists` 对齐：**只有明确的 `false` 才表示不存在**。
 * 这里没有「无法判定」的情形（文件系统要么答要么抛），抛错由调用方兜底放行。
 */
export function markdownProbeExists(probe: PageProbe): boolean {
  if (probe.kind === "tag") {
    const normalized = tagSlugOfName(decodeTagParam(probe.value));
    if (!normalized) return false;
    return visibleTagSlugs().has(normalized);
  }

  const kind = probe.contentType;
  if (kind === undefined) return true;
  return slugsByKind().get(kind)?.has(probe.value) ?? false;
}

/**
 * 仅供测试：清掉记忆化，让下一次判定重新扫盘。
 *
 * 生产环境才有缓存，所以这个函数在 dev / 测试里是空操作 —— 测试仍然需要它，
 * 因为测试可以在 `NODE_ENV=production` 下跑，也因为它让「同一进程里改了 md 再判」
 * 这种测试写法成为可能。
 */
export function resetMarkdownProbeCache(): void {
  slugIndex = undefined;
  tagIndex = undefined;
}
