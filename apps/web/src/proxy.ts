import { NextResponse, type NextRequest } from "next/server";

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

/**
 * 按 `source_path` 查一条重定向。
 *
 * 这里刻意**不复用** `lib/sources/db.ts` 的连接：那个模块带 `server-only`
 * 与整套 drizzle schema 依赖，而 Proxy 需要尽可能轻（它在每个请求前都跑）。
 * 用 postgres-js 直连一条参数化 SQL，是这里能拿到的最小实现。
 */
async function lookupRedirect(pathname: string): Promise<RedirectRow | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  const { default: postgres } = await import("postgres");
  const client = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 });

  try {
    const rows = await client<RedirectRow[]>`
      select target_path, status_code
      from redirects
      where source_path = ${pathname}
      limit 1
    `;
    return rows[0] ?? null;
  } finally {
    // Proxy 是无状态的一次性执行，必须自己关连接，否则每次请求都泄漏一个。
    await client.end({ timeout: 1 }).catch(() => {});
  }
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

  // markdown 源下不连库（见文件头）。
  if (process.env.CONTENT_SOURCE !== "db") return NextResponse.next();

  try {
    const row = await lookupWithTimeout(pathname);
    if (!row) return NextResponse.next();

    const status = ALLOWED_STATUS.has(row.status_code) ? row.status_code : 301;
    return NextResponse.redirect(new URL(row.target_path, request.url), status);
  } catch (error) {
    // 查库失败一律放行：旧链接跳转是可选功能，不能让它把站点变成 500。
    console.error("[proxy] 重定向查表失败，本次请求放行：", error);
    return NextResponse.next();
  }
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
