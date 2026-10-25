/**
 * Proxy 里「这条路径是不是一个内容详情页」的判定规则 —— 纯函数，无 I/O。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────
 * 这段逻辑要被两处消费：①`proxy.ts`（真实运行时）②离线测试（node --test）。
 * `proxy.ts` 依赖 `next/server` 的 `NextResponse` / `NextRequest`，而
 * `next/package.json` 没有 `exports` 字段、纯 node 里 `import("next/server")`
 * 直接 `ERR_MODULE_NOT_FOUND`。把判定规则抽出来，测试就只测规则本身，
 * 不需要伪造 NextResponse 那种复杂类（伪造出来的东西测的是桩不是代码）。
 *
 * ── 这个文件解决的问题：软 404 ───────────────────────────────────────
 * P7 生产构建验收实测（`next build` + `next start`，端口 3310）：
 *
 * ```
 * 首次请求（冷，该 URL 从未渲染过）
 *   200  /blog/nope-xxx-a         noindex=Y
 *   200  /diary/nope-xxx-b        noindex=Y
 *   200  /projects/nope-xxx-c     noindex=Y
 *   200  /tags/nope-xxx-d         noindex=Y
 * 同一 URL 第二次请求（热）
 *   404  /blog/nope-xxx-a         x-nextjs-cache=HIT
 *   ...
 * ```
 *
 * 根因是 Next 官方文档写明的机制（`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/not-found.md:193`）：
 * 「The response starts streaming from the `<Suspense>` boundary before `notFound()`
 * runs, so it keeps its `200` status.」
 *
 * 本项目所有详情页都是 `◐ Partial Prerender`（构建输出实测），shell 在构建期
 * 就预渲染好了，请求一来先吐 shell（200 已定），`await getPost(slug)` 之后才
 * `notFound()` —— 那时状态码已经发出去了。第二次请求命中缓存里那份 404，
 * 所以「同一 URL 第一次 200、第二次 404」。
 *
 * 官方给出的修法（同文件 :195 与 `loading.md:113`）：
 * 「Calling `notFound()` before streaming starts returns a `404`. … A request-time
 * check can run in Proxy before the page renders.」
 * 「For a `404`, you can check the slug in Proxy, then rewrite it to a not-found
 * route or return a `404` response. Keep Proxy checks fast, and avoid fetching
 * full content there.」
 *
 * → 于是本文件只负责「哪些路径需要做存在性检查、检查用的 key 是什么」，
 * 真正的查库在 `proxy.ts` 里（单连接、带超时、失败放行）。
 *
 * ── 为什么不能改成 `dynamicParams = false` ────────────────────────────
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route-segment-config/dynamicParams.md:22`
 * 逐字：「`dynamicParams` is not available when Cache Components is enabled.」
 * 本项目 `next.config.ts` 开了 `cacheComponents: true`，导这个会直接构建失败。
 * 迁移指南（`migrating-to-cache-components.md:648-654`）给的替代方案正是
 * 「call `notFound()` in the page when the param doesn't resolve to real data」——
 * 也就是现状，而现状正是软 404 的来源。所以只能走 Proxy。
 */

/** 无匹配内容时 rewrite 到的目标。Next 对 `/_not-found` 特殊处理，直接回 404 状态。 */
export const NOT_FOUND_PATH = "/_not-found";

/** 需要做 slug 存在性检查的内容详情前缀（与 `app/(site)/**\/[slug]/page.tsx` 一一对应）。 */
export const PROBEABLE_KINDS = ["blog", "diary", "projects"] as const;

export type ProbeableKind = (typeof PROBEABLE_KINDS)[number];

/** 标签详情页前缀（与 `app/(site)/tags/[tag]/page.tsx` 对应）。 */
export const TAG_SEGMENT = "tags";

/**
 * 一次存在性检查的目标。
 *
 * `value` 是**已解码**的路由段原文（`decodeURIComponent` 由 Next 完成，
 * 标签段还要再过 `decodeTagParam` 处理裸 `+`）。
 */
export interface PageProbe {
  /** `content` 走 `entries` 表；`tag` 走 `tags ⋈ entry_tags ⋈ entries`。 */
  kind: "content" | "tag";
  /** `content` 时是 `blog` / `diary` / `projects` 之一。 */
  contentType?: ProbeableKind;
  /** 待检查的路由段。 */
  value: string;
}

/**
 * 判断一条路径是否需要做「存在性检查」，需要则返回检查目标。
 *
 * ── 只认两段路径 ──────────────────────────────────────────────────────
 * - `/blog/<slug>`、`/diary/<slug>`、`/projects/<slug>` → `content`
 * - `/tags/<tag>` → `tag`
 *
 * 三段及以上（`/blog/a/b`）**不认**：那些路径没有任何 page 匹配，Next 自己就回
 * 真 404（不是软 404），proxy 不该插手，也省一次查库。
 *
 * 列表页（`/blog`、`/tags`）**不认**：它们永远存在，没有 404 概念。
 *
 * ── 为什么不用 `pathname.split("/")` ─────────────────────────────────
 * 尾部斜杠会产生空段（`/blog/x/` → `["", "blog", "x", ""]`），不同 Next 版本对
 * 尾斜杠的处理还不一致。这里用正则一次性锁死「恰好两段且无尾斜杠」，
 * 行为在测试里可穷举。
 */
export function parseProbeablePath(pathname: string): PageProbe | null {
  const contentMatch = /^\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (contentMatch === null) return null;

  const [, head, segment] = contentMatch;
  if (segment.length === 0) return null;

  if (head === TAG_SEGMENT) {
    return { kind: "tag", value: segment };
  }

  if ((PROBEABLE_KINDS as readonly string[]).includes(head)) {
    return { kind: "content", contentType: head as ProbeableKind, value: segment };
  }

  return null;
}
