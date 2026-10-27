import type { Metadata } from "next";

import { OpsNav } from "./ops-nav";

export const metadata: Metadata = { title: "运维台" };

/**
 * 运维台的外壳（`app/admin/ops/layout.tsx`）。
 *
 * ── 为什么这里没有守卫 ───────────────────────────────────────────────
 * `app/admin/layout.tsx:71-96` 的 `AdminGuard` 已经在 `/admin` 这一层拦过：
 * `getAdminSession()` 取不到就 `redirect("/login")`，而 layout 是逐层嵌套的，
 * 所以 `/admin/ops/**` 天然被覆盖。在子 layout 里再写一次不会更安全，只会
 * 在将来父级守卫被改动时留下一个「隐形覆盖」（与 `app/admin/media/page.tsx:23-25`
 * 的理由相同）。
 *
 * 真正的第二道在 `lib/ops/actions.ts` 的每个 action 里 —— 那是**不可绕过**的，
 * 因为 Server Function 不是独立路由，proxy 的 matcher 拦不到它。
 *
 * ── 为什么标题写在这里而不是每页重复 ─────────────────────────────────
 * 五张子页共享同一个标题与同一句「这里全是只读」的定性说明。写在 layout 里
 * 就不会出现某一页忘了说、让运维者以为某个按钮会改数据。
 */
export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">运维台</h1>
        <p className="mt-1 text-sm text-muted">
          数据库、检查、运行态、环境与平台的统一入口。
          <strong className="font-medium text-foreground"> 数据库连接全程只读</strong>
          —— 可以浏览结构、跑单条 SELECT、导出备份，但改不了任何一行数据。
        </p>
      </header>

      <OpsNav />

      {children}
    </div>
  );
}
