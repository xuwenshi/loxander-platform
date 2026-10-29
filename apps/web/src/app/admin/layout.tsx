import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { getAdminSession } from "@/lib/auth";
import { hasDatabaseUrl } from "@/lib/admin/db";

import { AdminChrome } from "./admin-chrome";

export const metadata: Metadata = {
  title: { default: "后台", template: "%s · 后台" },
  // 后台永远不该进搜索引擎。
  robots: { index: false, follow: false },
};

/**
 * 后台整棵树显式声明「导航允许阻塞」。
 *
 * ── 为什么需要这一行 ───────────────────────────────────────────────
 * 根布局（`app/layout.tsx:188`）里的 `CosmicTransitionProvider` 是客户端组件、
 * 读了 `usePathname()`。开了 `cacheComponents` 后 Next 在 dev 里会校验
 * 「导航是否立刻出 UI」，碰到「客户端 hook 在 `<Suspense>` 外」就报
 * blocking-prerender-client-hook（实测：`/admin/content/[kind]/[slug]` 与
 * `.../revisions` 的 stderr 告警，digest `CLIENT_HOOK_DYNAMIC`）。
 *
 * 后台本来就不该追求「即时导航」：每页都要读 cookie 校验会话再查库，天然阻塞。
 * 按 Next 16 文档（`node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/02-route-segment-config/instant.md:85-89,120`），
 * `instant = false` 同时关掉「即时导航校验」与「静态外壳校验」；文档要求
 * **放在尽可能低的位置** —— 放在 `/admin` 这一层，公开站点继续校验。
 */
export const instant = false;

/**
 * 后台路由的守卫层（`app/admin/layout.tsx`）。
 *
 * ── 为什么守卫放在 layout 而不只放 proxy ────────────────────────────
 * 两道都要有，但**只有 layout/server 这一道是真的**：
 * - Next 16 的 proxy 文档明确写（`proxy.md:249-251`）Server Function 不是
 *   独立路由，proxy matcher 排除掉的路径上 proxy 不拦 Server Action ——
 *   现有 `proxy.ts` 的 matcher 恰好排除了 `api/`，所以写操作必须自己校验。
 * - layout 这一道管的是「读页面」：任何 `/admin/**` 的渲染都先过 `getAdminSession()`。
 * - 第三道在 `lib/admin/actions.ts` 的每个 action 里 `requireAdmin()`。
 *
 * 三层重叠是刻意的：任何一层漏了，另外两层还在。
 *
 * ── 为什么守卫不在页面里 ───────────────────────────────────────────
 * 放在 layout 就不会出现「新加一个 /admin/xxx 页面忘了加判断」。子页面可以
 * 直接假定会话存在。
 *
 * ── Suspense 与 cacheComponents ──────────────────────────────────
 * 同 `/login`：`auth()` 读 cookies 属于运行时数据，必须在 `<Suspense>` 边界内
 * await，否则整段布局变成阻塞式预渲染，`next build` 报 blocking-prerender-runtime。
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<AdminBootScreen />}>
      <AdminGuard>{children}</AdminGuard>
    </Suspense>
  );
}

/**
 * 动态守卫：没登录就跳登录页。
 *
 * 直接用 `redirect()` 而不是 `notFound()` —— 后台存在这件事本身不算秘密
 * （它是 URL 里写明的），跳到登录页是更好的体验，也符合方案 §9.1
 * 「登录成功但账号不在白名单时，显示无权访问并清除会话」。
 */
async function AdminGuard({ children }: { children: React.ReactNode }) {
  // `auth()` 内部生成 CSRF token 会调 `crypto.getRandomValues()`。开了
  // `cacheComponents` 后这是「不稳定值」，在预渲染阶段碰到会报
  // blocking-prerender-crypto（实测：Route "/admin"、"content"、"audit"、"new"
  // 全部在 stderr 打出这条告警）。`connection()` 明确宣告「这棵子树必须等到
  // 请求到达才渲染」，于是下面的 `getAdminSession()` 不再走预渲染路径。
  // 文档：node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md
  await connection();

  const session = await getAdminSession();

  if (!session?.user?.id) {
    redirect("/login");
  }

  return (
    <AdminChrome
      githubLogin={session.user.githubLogin ?? null}
      userName={session.user.name ?? null}
      userImage={session.user.image ?? null}
      databaseReady={hasDatabaseUrl()}
    >
      {children}
    </AdminChrome>
  );
}

/**
 * 守卫求值期间的外壳。刻意只画骨架，不泄漏任何内容。
 *
 * `relative z-10` 与 admin-chrome.tsx 的外壳同一个理由：氛围层的暗角（z-1）
 * 与颗粒（z-2）是 position:fixed，这层不定位就会落在它们下面 —— 深色主题的
 * `--vig-2` 是 88% 近黑，连「正在校验身份…」这行字一起被压黑。
 *
 * 不铺 `bg-background`：抬到 z-10 之后它会把暗角与颗粒整块挡掉。`<body>`
 * 上已有同一枚令牌，视觉零变化，纸的质感却能透上来（与 admin-chrome 一致）。
 */
function AdminBootScreen() {
  return (
    <div className="relative z-10 flex min-h-screen items-center justify-center">
      <p className="text-sm text-muted">正在校验身份…</p>
    </div>
  );
}
