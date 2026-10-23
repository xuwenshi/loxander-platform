"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import {
  CheckCircleIcon,
  CloseIcon,
  ImageIcon,
  ListIcon,
  MenuIcon,
  FileTextIcon,
  LayersIcon,
  SettingsIcon,
} from "@/components/ui/Icons";

import { adminSignOutAction } from "@/lib/admin/actions";

/**
 * 后台外壳（侧边导航 + 顶栏 + 内容区）。
 *
 * ── 为什么是 Client Component ───────────────────────────────────
 * 需要 `usePathname()` 给当前页高亮，还要一个移动端抽屉的开合状态。这两件都
 * 是纯浏览器行为。所有真正敏感的东西（会话、白名单、数据库）都在父级
 * Server Component 里算完再以 props 传进来，客户端拿不到 token 或连接串。
 *
 * ── 为什么不在 (site) 布局上叠 ─────────────────────────────────
 * `(site)/layout.tsx` 带 Navbar/Footer 与宇宙主题的过渡层，后台需要的是
 * 「信息密度高、没有装饰」的界面。两套布局互不影响，改动也不会互相牵连。
 */
export interface AdminChromeProps {
  githubLogin: string | null;
  userName: string | null;
  userImage: string | null;
  databaseReady: boolean;
  children: React.ReactNode;
}

const NAV_ITEMS = [
  { href: "/admin", label: "总览", icon: LayersIcon, exact: true },
  { href: "/admin/content", label: "内容", icon: ListIcon, exact: false },
  { href: "/admin/media", label: "媒体", icon: ImageIcon, exact: false },
  { href: "/admin/audit", label: "审计日志", icon: CheckCircleIcon, exact: false },
  { href: "/admin/new", label: "新建内容", icon: FileTextIcon, exact: true },
  { href: "/admin/settings", label: "设置", icon: SettingsIcon, exact: true },
] as const;

export function AdminChrome({
  githubLogin,
  userName,
  userImage,
  databaseReady,
  children,
}: AdminChromeProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isActive = (item: (typeof NAV_ITEMS)[number]) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <div className="flex min-h-screen flex-col bg-background lg:flex-row">
      {/* 顶栏：移动端放抽屉按钮，桌面端只在左侧栏出现。 */}
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 lg:hidden">
        <span className="text-sm font-semibold text-foreground">后台</span>
        <button
          type="button"
          onClick={() => setDrawerOpen((open) => !open)}
          aria-label={drawerOpen ? "关闭菜单" : "打开菜单"}
          aria-expanded={drawerOpen}
          className="rounded-lg border border-border p-2 text-muted hover:text-accent"
        >
          {drawerOpen ? <CloseIcon width={16} height={16} /> : <MenuIcon width={16} height={16} />}
        </button>
      </header>

      {/* 侧边栏：移动端是抽屉，桌面端常驻。 */}
      <aside
        className={[
          "border-border bg-surface lg:w-60 lg:shrink-0 lg:border-r",
          drawerOpen ? "block border-b" : "hidden lg:block",
        ].join(" ")}
      >
        <div className="flex h-full flex-col gap-6 p-4">
          <div className="hidden lg:block">
            <p className="text-sm font-semibold tracking-tight text-foreground">Loxander 后台</p>
            <p className="mt-1 text-xs text-muted">内容管理与发布</p>
          </div>

          <nav aria-label="后台导航">
            <ul className="space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = isActive(item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setDrawerOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={[
                        "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-accent/10 font-medium text-accent"
                          : "text-muted hover:bg-elevated hover:text-foreground",
                      ].join(" ")}
                    >
                      <Icon width={15} height={15} />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="mt-auto space-y-3 border-t border-border pt-4">
            {/* 数据库没配时明确告知：后台所有写操作都会失败，别让人猜。 */}
            {databaseReady ? null : (
              <p
                role="alert"
                className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed text-warning"
              >
                未配置 DATABASE_URL，后台只能看空列表。
              </p>
            )}

            <div className="flex items-center gap-2">
              {userImage ? (
                // 头像来自 GitHub，域名在 next.config 里不受 image 组件约束
                // （这里用的是原生 img，不走 next/image 优化）。
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={userImage}
                  alt=""
                  width={28}
                  height={28}
                  className="h-7 w-7 rounded-full border border-border"
                />
              ) : (
                <div className="h-7 w-7 rounded-full border border-border bg-elevated" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-foreground">
                  {userName ?? githubLogin ?? "管理员"}
                </p>
                {githubLogin ? (
                  <p className="truncate text-[11px] text-muted">@{githubLogin}</p>
                ) : null}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <Link href="/" className="text-xs text-muted hover:text-accent">
                返回站点
              </Link>
              <form action={adminSignOutAction}>
                <button
                  type="submit"
                  className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-error hover:text-error"
                >
                  登出
                </button>
              </form>
            </div>
          </div>
        </div>
      </aside>

      <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
