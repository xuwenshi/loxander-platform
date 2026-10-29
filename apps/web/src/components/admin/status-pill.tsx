import { STATUS_LABELS, type AdminStatus } from "@/lib/admin/validation";

/**
 * 状态徽标（后台通用）。
 *
 * ── 为什么不复用 `components/ui/Badge.tsx` 的 `StatusBadge` ─────────
 * 那个是给**项目**状态用的（active / in-progress / completed / archived，
 * 文案是「维护中 / 开发中 / 已完成 / 已归档」），对应 `content-core` 的
 * `PROJECT_STATUSES`。后台要表达的是**发布状态**
 * （draft / scheduled / published / archived），两套枚举的 `archived` 含义
 * 完全不同（一个是项目归档，一个是内容下线），共用会让人误解。
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────────
 * 之前它写在 `app/admin/page.tsx` 里，列表页 `import { StatusPill } from "../page"`
 * ——从 page 模块里取组件是脆的：page 一旦改成默认导出重定向或加 `"use client"`，
 * 取组件的页面就会跟着变形。挪到组件目录后两边都只依赖这个文件。
 *
 * 色只用语义令牌（`--success` / `--warning` / `--muted`），暗色模式自动跟随。
 */
export function AdminStatusPill({ status }: { status: string }) {
  const label = STATUS_LABELS[status as AdminStatus] ?? status;
  const tone =
    status === "published"
      ? "border-success/35 text-success"
      : status === "scheduled"
        ? "border-warning/40 text-warning"
        : status === "archived"
          ? "border-border text-muted-deep"
          : "border-border text-muted";

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-xs border px-2 py-0.5 font-mono text-[11px] tracking-[0.04em] ${tone}`}
    >
      {label}
    </span>
  );
}
