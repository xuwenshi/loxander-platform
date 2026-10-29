import Link from "next/link";
import type { ReactNode } from "react";

import { tagHref } from "@/lib/tag-url";

/**
 * 标签样式的小方角 chip，博客与项目共用。
 *
 * 换皮后从 `rounded-full`（胶囊）改成 `rounded-xs`（1px 直角）：
 * 原型里所有标签都是 `.dossier .stack i { border-radius:1px }`
 * （`_prototype/redesign.html:785`）与 `.sheet-meta i { border-radius:1px }`
 * （`:1061`）—— 它们是铭牌上的刻字，不是聊天软件的胶囊。
 * 全站 `rounded-full` 只剩「真正是圆的」东西：星球、状态点、色板点。
 */
export function Chip({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-xs border border-border bg-surface px-2.5 py-0.5 font-mono text-[0.6875rem] tracking-[0.06em] text-muted ${className}`}
    >
      {children}
    </span>
  );
}

/** 技术栈 / 技能标签：等宽字体的小方块，about 与 resume 共用同一份样式 */
export function TechChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-xs border border-border bg-surface px-2 py-0.5 font-mono text-[0.6875rem] tracking-[0.02em] text-muted">
      {children}
    </span>
  );
}

/**
 * 可点击的标签 → 标签页。
 *
 * P5 之前 href 硬编码 `/blog`（点了只是回到博客列表，等于没筛选）。
 * 现在指向 `/tags/<归一化标签>`，URL 由 `tagHref()` 统一生成 ——
 * 大小写、空格、斜杠的编码规则只在那一个地方，页面与组件不再各写一套。
 */
export function TagLink({ tag }: { tag: string }) {
  return (
    <Link
      href={tagHref(tag)}
      className="inline-flex items-center rounded-xs border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-muted transition-colors hover:border-accent/60 hover:text-foreground"
    >
      {tag}
    </Link>
  );
}

const STATUS_LABELS: Record<string, string> = {
  active: "维护中",
  "in-progress": "开发中",
  completed: "已完成",
  archived: "已归档",
};

/**
 * 项目状态徽标配色。
 *
 * 全部走语义令牌（success / warning / accent），不再硬编码 emerald / amber / sky：
 * ① 浅色与深色两套值在 globals.css 里各定义一次，这里只表达「语义」；
 * ② 换主题时不会再出现「某个 chip 忘了跟着改」的漂移。
 * 「已完成」用 accent 而不是 error —— 完成是中性偏正面的状态，
 * 红色会误导成出错；error 令牌留给真正的错误界面（app/error.tsx）。
 */
const STATUS_STYLES: Record<string, string> = {
  active: "border-success/35 text-success",
  "in-progress": "border-warning/35 text-warning",
  completed: "border-accent/35 text-accent",
  archived: "border-border text-muted",
};

/** 项目状态徽标 */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-xs border bg-transparent px-2.5 py-0.5 text-xs font-medium ${
        STATUS_STYLES[status] ?? STATUS_STYLES.archived
      }`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}