"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 运维台二级导航。
 *
 * ── 为什么是 Client Component ────────────────────────────────────────
 * 只有一件事需要浏览器：`usePathname()` 判断当前页高亮。所有数据都在
 * 父级 Server Component 里算完，这里不碰任何敏感信息。
 *
 * ── 为什么用 `exact` 而不是一律前缀匹配 ──────────────────────────────
 * `/admin/ops/db/entries`（单表结构页）是 `/admin/ops/db` 的子路径，前缀匹配
 * 会让「数据库」和它自己同时高亮。`/admin/ops` 这个根同理 —— 它是
 * `/admin/ops/checks` 等所有页的前缀，必须 `exact`。
 * 与 `admin-chrome.tsx:59-60` 的判定口径保持一致。
 */
const OPS_NAV = [
  { href: "/admin/ops", label: "总览", exact: true },
  { href: "/admin/ops/db", label: "数据库", exact: false },
  { href: "/admin/ops/checks", label: "检查", exact: true },
  { href: "/admin/ops/runtime", label: "运行态", exact: true },
  { href: "/admin/ops/env", label: "环境与平台", exact: true },
] as const;

export function OpsNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="运维台导航" className="mt-6 border-b border-border">
      <ul className="-mb-px flex flex-wrap gap-1">
        {OPS_NAV.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  // min-h-11：导航是最高频点击目标，命中区域 44px（WCAG 2.5.5）。
                  "inline-flex min-h-11 items-center rounded-t-lg border-b-2 px-3 text-sm transition-colors",
                  active
                    ? "border-accent font-medium text-accent"
                    : "border-transparent text-muted hover:text-foreground",
                ].join(" ")}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
