import { NextResponse, type NextRequest } from "next/server";

import { parseProbeablePath, NOT_FOUND_PATH, type PageProbe } from "@/lib/proxy-rules";
import { markdownProbeExists } from "@/lib/proxy-markdown-probe";
import { decodeTagParam, tagSlugOfName } from "@/lib/tag-url";

/**
 * 旧 slug 301 重定向（P3「增加旧 slug 重定向」）。
 *
 * ── 为什么是 `proxy.ts` 而不是 `middleware.ts` ────────────────────────
 * Next 16 把 `middleware` 文件约定改名为 `proxy`（见
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:1`
 * 与 :806 的版本表「Middleware is deprecated and renamed to Proxy」）。
 * 继续用 `middleware.ts` 会拿到弃用警告，且 v17 大概率移除。
 *
 * ── 为什么查表放在这里，而不是在页面里 `notFound()` ──────────────────
 * 重定向必须在**页面渲染之前**发生，否则会先吐一个 404 再跳，搜索引擎会把
 * 旧 URL 记成「死链」。Proxy 是唯一能在此阶段拦截的地方。
 *
 * ── 为什么读数据库而不是静态 map ─────────────────────────────────────
 * `redirects` 表（`db/schema.ts:193-206`）就是为这件事建的，P4 后台会让用户
 * 自己维护「旧链接 → 新链接」。写死一份 map 等于让这张表永远空着。
 *
 * ── ⚠️ 本文件的失败策略 ─────────────────────────────────────────────
 * 查库失败（网络抖动、DATABASE_URL 没配、迁移没跑）时**必须放行**（`return NextResponse.next()`），
 * 不能 500：一个可选的旧链接跳转功能挂掉，不该让整个站点打不开。
 * 这与方案 §14.3「失效失败时记录错误、不回滚已提交内容」是同一套思路。
 *
 * ── 为什么只在 db 源下查库 ───────────────────────────────────────────
 * `CONTENT_SOURCE=markdown` 时项目按设计就不连库（P0/P1 的约束），
 * 此时 `redirects` 表可能压根不存在。用环境变量把两条路彻底分开，
 * 避免「本地没配库 → 每个请求都抛一次连接错误」这种噪音。
 */

/**
 * 静态兜底映射：**不依赖数据库**也能生效的旧链接。
 *
 * 目前为空 —— P3 之前站点从没有过别的 slug 形态，没有历史链接要救。
 * 保留这个常量是因为它有一个数据库替代不了的用途：**回滚**。
 * 若某次改名把 `redirects` 表也一起弄坏了，这里手写几行就能立刻救回流量，
 * 不必等数据库恢复。
 */
const STATIC_REDIRECTS: Readonly<Record<string, string>> = {};

/** 只有这些状态码允许从库里读出后直接用（与 DDL 的 CHECK 约束一致）。 */
const ALLOWED_STATUS = new Set([301, 302, 307, 308]);

/** 单次查库的超时（毫秒）。超时就放行，不拖慢页面。 */
const LOOKUP_TIMEOUT_MS = 800;

/**
 * 详情页存在性检查的超时（毫秒）。
 *
 * ── 为什么是 5000ms 而不是 1000ms（实测教训）──────────────────────────
 * 第一版写 1000ms（比 `LOOKUP_TIMEOUT_MS` 宽 200ms 而已），结果**软 404 没修掉**：
 * 冷连接超时 → 判定「无法确定」→ 放行 → 页面自己 `notFound()` → 但状态码已定成 200。
 *
 * 实测（`.tmp-neon-latency.mjs`，P6 期同一台机器）：
 * ```
 * cold connect+select1 = 4320 ms
 * warm #0              =  815 ms
 * warm #1              =  228 ms
 * warm #2              =  286 ms
 * ```
 * 1000ms 只能兜住「已预热」的情形，第一次请求必然漏。所以这里必须**大于冷启动**。
 *
 * ── 代价与取舍 ──────────────────────────────────────────────────────
 * 这个探针只在「详情页 + 数据库源」的请求上跑，且只在 proxy 里查一列 `1`。
 * 冷连接时它会给该次请求的首字节时间加最多 ~4.3 秒 —— 换来的是**正确的 404 语义**。
 * 若库真的挂了，超时后仍会放行（`null` → 当作存在），不会把站点变成 500。
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Auth.js v5 的会话 Cookie 名。
 *
 * 依据 `node_modules/@auth/core/lib/utils/cookie.js:44` 的 `defaultCookies(useSecureCookies)`：
 * HTTPS 下带 `__Secure-` 前缀，HTTP 下不带。两个都要认 —— 本地 dev 是 http。
 * 这里**只判断「有没有这个 cookie」**，不验签、不查库：真正的会话有效性
 * 由 `app/admin/layout.tsx` 的 `getAdminSession()` 与每个 Server Action 的
 * `requireAdmin()` 负责。proxy 这一道的目的只有一个 —— **让未登录请求在
 * 任何 RSC 渲染发生之前就掉头**。
 */
const SESSION_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

function hasSessionCookie(request: NextRequest): boolean {
  return SESSION_COOKIE_NAMES.some((name) => Boolean(request.cookies.get(name)?.value));
}

/**
 * 后台入口的「门前拦截」。
 *
 * ── 为什么必须在 proxy 里再拦一次（实测发现的真实缺陷）────────────────
 * 只靠 `app/admin/layout.tsx` 的守卫**会泄漏后台内容**。原因：layout 用
 * `<Suspense><AdminGuard>{children}</AdminGuard></Suspense>`，而 `children`
 * 是独立 segment，会与 guard **并行开始渲染**。guard 里 `redirect()` 抛异常时，
 * 子页面已经查完库、结果已经被序列化进 RSC flight payload —— 实测未登录请求
 * `/admin` 返回的 HTML 里可见文本确实只有「正在校验身份…」，但
 * `<script>self.__next_f.push(...)</script>` 里带着 8 条内容的标题与 UUID、
 * 以及「已发布 12 / 草稿 4」这类统计。这违反方案 §11 P4 验收第 3 条的精神。
 *
 * proxy 跑在任何渲染之前，这里掉头，子页面根本不会开始渲染。
 *
 * ── 为什么只查 cookie 存在性、不查会话有效性 ─────────────────────────
 * proxy 在每个请求前都跑，且要尽可能轻（见文件头「为什么不复用 lib/sources/db.ts」）。
 * 这里查库会把它变成第二个鉴权中心，还会因为超时策略不同产生两套真相。
 * 分层：proxy 挡「没带票的人」，layout 与 action 挡「票过期/不在白名单的人」。
 */
function guardAdminArea(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl;

  if (pathname !== "/admin" && !pathname.startsWith("/admin/")) return null;
  if (hasSessionCookie(request)) return null;

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/admin") {
    loginUrl.searchParams.set("callbackUrl", pathname);
  }
  return NextResponse.redirect(loginUrl, 307);
}

interface RedirectRow {
  target_path: string;
  status_code: number;
}

/* -------------------------------------------------------------------------- */
/* 数据库连接（进程内复用已解析实例）                                           */
/* -------------------------------------------------------------------------- */

/**
 * 建连函数的最小类型（只用到这一个成员）。
 *
 * 不引 `postgres` 的类型：那个包只在 `CONTENT_SOURCE=db` 时才动态 import，
 * 提到类型层会让 `markdown` 部署也把它的 `.d.ts` 拉进编译图。
 */
type SqlClient = {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...args: unknown[]): Promise<T[]>;
  end: (options?: { timeout?: number }) => Promise<void>;
};

/**
 * 已解析的连接实例（**不是 Promise**）。
 *
 * ── 为什么要复用 ────────────────────────────────────────────────────
 * P7 收口时用真实浏览器验收发现详情页要 3–5 秒。逐步测量后定位到：本文件
 * 曾经在 `lookupRedirect` 与 `probePageExists` 里**各自新建一条 postgres 连接**
 * 并在 `finally` 里立刻关掉。Neon 冷建连实测 3 362ms（`.tmp-p7-dbperf.mjs`），
 * 所以每个详情页请求都要白付一次建连成本 —— 而 proxy 跑在每个请求前。
 *
 * 复用之后同一条连接在进程内长期存活，`max: 1` 的池子只建一次。
 *
 * ── 为什么缓存「实例」而不是「Promise」（与 `lib/sources/db.ts` 同源教训）
 * P6 期那个真实缺陷：模块作用域缓存 Promise，被 `"use cache"` 作用域跨域 await
 * 时报「A `"use cache"` function is awaiting a promise created outside it」。
 * proxy 里虽然没有 `"use cache"`，但保持同一写法，避免将来有人把这段代码
 * 搬进带缓存的作用域时再踩一次。
 *
 * ── 什么时候该关 ────────────────────────────────────────────────────
 * proxy 是长驻进程，不需要在请求结束时关连接。热重载 / 进程退出时由 Node 回收。
 * 这里不提供 close 钩子：**proxy 模块不该在请求生命周期里管理连接池**。
 */
let cachedClient: SqlClient | undefined;

/**
 * 取（或建）proxy 用的数据库连接。
 *
 * 返回 `null` 表示「没法查」（没配 `DATABASE_URL`），调用方按各自的失败策略处理：
 * - `lookupRedirect` → 当作「没有重定向」，放行
 * - `probePageExists` → 返回 `null`（无法判定），放行
 *
 * 建连的 Promise 由**本次调用自己创建**，不挂在模块作用域上（见 `cachedClient` 注释）。
 */
async function getClient(): Promise<SqlClient | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (cachedClient) return cachedClient;

  const { default: postgres } = await import("postgres");
  const created = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 }) as unknown as SqlClient;

  // 并发首达：别人先装上了就关掉自己这条，避免池子泄漏（与 `lib/sources/db.ts:getDb()` 同构）。
  if (cachedClient) {
    await created.end({ timeout: 1 }).catch(() => {});
    return cachedClient;
  }

  cachedClient = created;
  return cachedClient;
}

/**
 * 按 `source_path` 查一条重定向。
 *
 * 这里刻意**不复用** `lib/sources/db.ts` 的连接：那个模块带 `server-only`
 * 与整套 drizzle schema 依赖，而 Proxy 需要尽可能轻（它在每个请求前都跑）。
 * 用 postgres-js 直连一条参数化 SQL，是这里能拿到的最小实现。
 *
 * 连接复用见 `getClient()` —— 早先每次新建，导致每个详情页请求多付 3.4 秒建连。
 */
async function lookupRedirect(pathname: string): Promise<RedirectRow | null> {
  const client = await getClient();
  if (client === null) return null;

  const rows = await client<RedirectRow>`
    select target_path, status_code
    from redirects
    where source_path = ${pathname}
    limit 1
  `;
  return rows[0] ?? null;
}

/** 给查库整体套一个超时，避免慢查询把页面响应一起拖垮。 */
async function lookupWithTimeout(pathname: string): Promise<RedirectRow | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
  });

  try {
    return await Promise.race([lookupRedirect(pathname), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 内容 / 标签详情页的**存在性检查**（P7 修软 404）。
 *
 * ── 缺陷本体 ─────────────────────────────────────────────────────────
 * 生产构建实测（`next start`，端口 3310）：同一个不存在的 URL，
 * **第一次请求返回 `200`，第二次才返回 `404`**：
 * ```
 * 首次 200  /blog/nope-xxx-a   noindex=Y  x-nextjs-cache=-
 * 二次 404  /blog/nope-xxx-a   noindex=Y  x-nextjs-cache=HIT
 * ```
 * 四个详情页前缀（`/blog/` `/diary/` `/projects/` `/tags/`）全部复现。
 * 旧站（`https://loxander.is-a.dev`）对同样五条路径**全部正确 404** ——
 * 所以这是新站相对旧站的**行为退化**，落在方案 P7 验收第 2 条「旧 URL 正常」里。
 *
 * ── 根因（Next 官方文档逐字）────────────────────────────────────────
 * `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/not-found.md:193`：
 * 「The response starts streaming from the `<Suspense>` boundary before `notFound()`
 * runs, so it keeps its `200` status.」
 * 本项目所有详情页构建产物都是 `◐ Partial Prerender`：shell 在构建期预渲染，
 * 请求一来先把 shell 吐出去（状态码此刻已定为 200），`await getX(slug)` 之后
 * 才 `notFound()`。第二次请求命中缓存里那份真 404，所以「第一次 200、第二次 404」。
 *
 * ── 为什么修在这里 ───────────────────────────────────────────────────
 * 同文件 `:195`：「A request-time check can run in Proxy before the page renders.」
 * `loading.md:113`：「For a `404`, you can check the slug in Proxy, then rewrite it
 * to a not-found route or return a `404` response. **Keep Proxy checks fast, and
 * avoid fetching full content there.**」
 * → 只查 `exists`，不取任何字段，不 join 正文。
 *
 * ── 为什么不能用 `dynamicParams = false` ─────────────────────────────
 * `dynamicParams.md:22`：「`dynamicParams` is not available when Cache Components
 * is enabled.」本项目开了 `cacheComponents: true`，导它直接构建失败。
 *
 * ── 失败策略：与重定向查表一致，一律放行 ────────────────────────────
 * 查库失败 / 超时 / 没配 DATABASE_URL → 返回 `null`（＝「当作存在」），
 * 交给页面自己 `notFound()`。理由同文件头：可选的 404 纠偏功能不该把站点变成 500。
 * 代价是「库挂了的时候软 404 会回来」——这比整站 500 好得多。
 */
async function probePageExists(probe: PageProbe): Promise<boolean | null> {
  // 与页面层同一条可见性判据（`lib/sources/db.ts` 的 `includeDrafts`）：
  // 生产只认 published；非生产把草稿也算「存在」，否则本地看草稿会被这里误杀。
  const publishedOnly = process.env.NODE_ENV === "production";

  const client = await getClient();
  // 没配 DATABASE_URL → 无法判定，交给页面自己 notFound()。
  if (client === null) return null;

  if (probe.kind === "tag") {
    // 标签页的「存在」判据与 `getPostsByTag()` 一致：这个标签下**至少有一篇可见文章**。
    // 只查 `tags` 表会漏掉「标签建了但文章全删了」的空页面 —— 那种页面在
    // `app/(site)/tags/[tag]/page.tsx` 里会走 `notFound()`，这里必须同样判空。
    const tagSlug = tagSlugOfName(decodeTagParam(probe.value));
    if (!tagSlug) return false;

    // ⚠️ 必须 `lower(t.name)` 而不是 `t.slug`，且必须带 `e.kind = 'blog'` + 可见性过滤。
    //
    // 判据必须与页面**完全一致**：`app/(site)/tags/[tag]/page.tsx:78-79` 是
    // `tags.find(({ tag: name }) => tagSlugOfName(name) === param)`，而那个 `tags`
    // 来自 `getAllTags()` —— 它的实现是遍历 `getAllPostsCached()` 的 `post.tags`，
    // 而 `post.tags` 由 `loadTagNamesOf()` 从 **`tags.name`** 填充（不是 `tags.slug`，
    // `db/mapping.ts` 的 `tagSlugOf()` 是恒等函数，slug 存的是原文）。
    // 所以 URL 段对应的永远是**标签名**，且只统计**可见文章**上的标签。
    // 若这里改用 `t.slug` 或去掉 entries 过滤，就会出现「proxy 说有、页面 404」
    // 或反过来的错配。
    const rows = await client<{ one: number }>`
      select 1 as one
      from tags t
      join entry_tags et on et.tag_id = t.id
      join entries e on e.id = et.entry_id
      where lower(t.name) = ${tagSlug}
        and e.kind = 'blog'
        ${publishedOnly ? client`and e.publish_status = 'published'` : client``}
      limit 1
    `;
    return rows.length > 0;
  }

  const rows = await client<{ one: number }>`
    select 1 as one
    from entries
    where kind = ${probe.contentType ?? ""}
      and slug = ${probe.value}
      ${publishedOnly ? client`and publish_status = 'published'` : client``}
    limit 1
  `;
  return rows.length > 0;
}

/**
 * 存在性检查 + 超时。
 *
 * ── 返回值是**三态**，只有明确 `false` 才算「不存在」 ────────────────
 * `probePageExists` 返回 `boolean | null`：
 * - `true`  → 查到，存在
 * - `false` → 查了，确认不存在 → **这是唯一会 rewrite 成 404 的分支**
 * - `null`  → 没配 DATABASE_URL，无法判定 → 放行
 *
 * 超时同样 resolve `null`（无法判定）→ 放行。
 *
 * ⚠️ 这里踩过一次真实事故（必须留档）：第一版写成 `return result === true`，
 * 于是「超时」被当成「不存在」。而 Neon 冷启动实测 4320ms、探针超时 1000ms，
 * 结果**全部详情页在冷连接窗口内返回 404**（实测 `/blog/rag-chunking-strategies`
 * 也 404），比原来的软 404 严重得多。正确写法是 `result !== false` ——
 * 把「无法判定」和「确认不存在」彻底分开。
 */
async function probeWithTimeout(probe: PageProbe): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([probePageExists(probe), timeout]);
    // 只有明确的 false 才判「不存在」；null（超时 / 没配库）一律放行。
    return result !== false;
  } catch (error) {
    console.error("[proxy] 详情页存在性检查失败，本次请求放行：", error);
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把「不存在的详情页」rewrite 成 404。
 *
 * ── 为什么必须显式写 `status: 404`（线上真事故，必须留档）─────────────
 * `NextResponse.rewrite(destination)` 不带 init 时，底层是
 * `new NextResponse(null, { headers })` —— **状态码是默认的 200**
 * （`node_modules/next/dist/server/web/spec-extension/response.js:108-116`，
 * `static rewrite` 只 `headers.set('x-middleware-rewrite', ...)` 就返回）。
 *
 * 而 Next 服务端拿 middleware 的 status 当最终状态码：
 * `node_modules/next/dist/server/lib/router-utils/resolve-routes.js:377`
 * `res.statusCode = middlewareRes.status;`。rewrite 分支（:468-486）只改
 * `parsedUrl`，**不重置 status**，于是 200 一路带到底。
 *
 * 本地 `next start` 看不出来：`server/base-server.js:1519` 有一条
 * `if (is404Page && !isNextDataRequest && !isRSCRequest) res.statusCode = 404;`
 * 会把 200 掰回 404。但 Vercel 是 minimalMode + PPR，走的是
 * `build/templates/app-page-runtime.js`：`/_not-found` 是**预渲染静态页**，
 * 命中缓存后 `:1390-1392` 的 `if (cachedData.status && ...) res.statusCode = cachedData.status;`
 * 只在缓存条目自带 status 时才覆盖 —— 而 rewrite 请求的状态码在到达这里之前
 * 就已经是 middleware 给的 200，于是最终以 **200 + `x-nextjs-prerender: 1`**
 * 发给浏览器并被 CDN 缓存（实测 `x-vercel-cache: HIT`）。
 * 后果：搜索引擎会把这些 URL 当正常页面收录（软 404），而且
 * `<meta name="robots" content="noindex">` 也不会出现（那是 404 分支才注入的）。
 *
 * 官方文档 `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md:107-118`
 * 也明确说了：流式 404 的 HTTP 状态可能是 200，要靠 `noindex` 兜住，
 * 而「想在响应体流出前就给出 404，就在 Proxy 里检查并把状态码定下来」。
 *
 * 所以这里统一走一个函数，把 `status: 404` 和「为什么不带就错」绑在一起，
 * 避免以后有人图省事又写回单参数形式。
 */
function notFoundRewrite(request: NextRequest): NextResponse {
  return NextResponse.rewrite(new URL(NOT_FOUND_PATH, request.url), { status: 404 });
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // 后台先挡：未带会话 Cookie 的请求在任何渲染发生之前就掉头（见 guardAdminArea）。
  const guarded = guardAdminArea(request);
  if (guarded) return guarded;

  // 静态兜底优先：它比数据库更可靠，也省一次查询。
  const staticTarget = STATIC_REDIRECTS[pathname];
  if (staticTarget) {
    return NextResponse.redirect(new URL(staticTarget, request.url), 301);
  }

  // markdown 源：不连库（见文件头），但**存在性检查照样要做** ——
  // 否则回滚到 markdown 时软 404 全回来（方案 §16.2 把 markdown 定义为回滚通道）。
  if (process.env.CONTENT_SOURCE !== "db") {
    const mdProbe = parseProbeablePath(pathname);
    if (mdProbe !== null) {
      let exists = true;
      try {
        exists = markdownProbeExists(mdProbe);
      } catch (error) {
        // 与 db 路径同一套失败策略：判不了就放行，不能把站点变成 500。
        console.error("[proxy] markdown 存在性检查失败，本次请求放行：", error);
      }
      if (!exists) return notFoundRewrite(request);
    }
    return NextResponse.next();
  }

  try {
    // 先看是不是旧链接：命中就 301，比存在性检查更优先
    // （旧链接的目标可能已经不存在，但跳转本身仍是正确行为）。
    const row = await lookupWithTimeout(pathname);
    if (row) {
      const status = ALLOWED_STATUS.has(row.status_code) ? row.status_code : 301;
      return NextResponse.redirect(new URL(row.target_path, request.url), status);
    }
  } catch (error) {
    // 查库失败一律放行：旧链接跳转是可选功能，不能让它把站点变成 500。
    console.error("[proxy] 重定向查表失败，本次请求放行：", error);
    return NextResponse.next();
  }

  // 不是旧链接，再看是不是「不存在的详情页」—— 是就 rewrite 到 /_not-found，
  // 让状态码在响应体开始流出之前就定成 404（见 probePageExists 的缺陷说明）。
  const probe = parseProbeablePath(pathname);
  if (probe !== null) {
    const exists = await probeWithTimeout(probe);
    if (!exists) {
      return notFoundRewrite(request);
    }
  }

  return NextResponse.next();
}

/**
 * 只对「像页面」的请求生效。
 *
 * 必须排除 `_next`（构建产物）、`api`（P4 的后台接口）、以及带扩展名的静态资源，
 * 否则重定向逻辑会介入 CSS / JS / 图片的加载。
 */
export const config = {
  matcher: [
    /*
     * 匹配所有不以 `_next/`、`api/` 开头，且不含 `.`（即不是静态文件）的路径。
     * 这是 Next 官方推荐的「排除静态资源」写法。
     */
    "/((?!_next/|api/|.*\\..*).*)",
  ],
};
