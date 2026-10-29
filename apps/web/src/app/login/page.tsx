import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { auth } from "@/lib/auth";

import { LoginPanel } from "./login-panel";

export const metadata: Metadata = {
  title: "登录",
  // 登录页不该被搜索引擎收录，也不该出现在 sitemap 里。
  robots: { index: false, follow: false },
};

/**
 * 登录页（/login）。
 *
 * ── 为什么挂在 `app/login` 而不是 `app/(site)/login` ────────────────
 * `(site)/layout.tsx` 会套上 Navbar + Footer，登录页需要的是「一整屏、无干扰」
 * 的形态；更重要的是后台相关页面不该复用公开站点的布局 —— 以后有人给公开布局
 * 加统计脚本时，不会把登录页一起带上。
 *
 * ── 页面本体必须是纯静态外壳 ─────────────────────────────────────────
 * 本项目开了 `cacheComponents`。读 cookies（`auth()` 内部就会读）属于运行时数据，
 * 在页面顶层直接 await 会让整页退化成阻塞式预渲染 —— Next 会报
 * **blocking-prerender-runtime** insight，`next build` 直接失败。
 * 正确形态（`node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md:725-823`）：
 * 页面渲染静态外壳，把动态读取**收进 `<Suspense>` 边界**，动态部分在请求时流式补上。
 * 所以这个文件的顶层只有 JSX，`auth()` 与 `searchParams` 的 await 全在下边两个
 * Suspense 子组件里。
 */
export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  return (
    /* relative z-10：暗角（z-1）/颗粒（z-2）是 position:fixed，登录页不定位
       就会被它们盖住，深色主题下表单文字发黑。与 (site)/layout.tsx 同一个理由。 */
    <main
      id="main"
      className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 py-16"
    >
      <div className="w-full max-w-sm">
        <Suspense fallback={<LoginPanel error={null} />}>
          <LoginContent searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

/**
 * 动态部分：已登录则直接跳后台，否则渲染登录面板。
 *
 * `searchParams` 与 `auth()` 都在这里 await —— 这是整个页面唯一接触运行时数据的地方。
 * `redirect()` 在 Suspense 边界内调用是安全的：它靠抛异常实现，Next 会在流式
 * 阶段把它转换成客户端跳转指令。
 */
async function LoginContent({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  // `auth()` 内部生成 CSRF token 会调 `crypto.getRandomValues()`。开了
  // `cacheComponents` 后这是个「不稳定值」，在预渲染阶段碰到会报
  // blocking-prerender-crypto（实测：Route "/login" 的 stderr 告警）。
  // `connection()` 明确宣告「这个子树必须等到请求到达才渲染」，
  // 于是下面的 `auth()` 不再是预渲染路径。
  // 文档：node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md
  await connection();

  const params = await searchParams;
  const session = await auth();

  if (session?.user) {
    redirect("/admin");
  }

  return <LoginPanel error={params.error ?? null} />;
}
