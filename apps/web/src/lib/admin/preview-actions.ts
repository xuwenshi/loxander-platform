"use server";

import { renderMarkdown } from "@loxander/markdown";
import type { EntryKind } from "@loxander/content-core";

import { requireAdmin } from "../auth";
import { buildPreviewHtml, type PreviewResult } from "./preview";

/**
 * 预览的 Server Action。
 *
 * ── 为什么预览要走服务端 ─────────────────────────────────────────────
 * 方案 §9.4 要求预览必须「关闭 raw HTML → rehype-sanitize → DOMPurify」。
 * 共享渲染管线（`@loxander/markdown`）依赖 Shiki 高亮器，而 Shiki 的初始化
 * 在浏览器里要加载几 MB 的语法包 —— 放进客户端组件会让后台首屏变得很慢。
 * 更关键的是：**预览必须与线上渲染逐字节一致**，把管线搬一份到浏览器里
 * 就多了一个会漂移的实现，这正是 P3 花力气统一渲染入口要避免的事。
 *
 * ── 为什么要再调一次 requireAdmin ────────────────────────────────────
 * Next 16 的 proxy 文档（`proxy.md:249-251`）明确说 Server Function 不是独立
 * 路由、matcher 排除的路径上 proxy 不会拦。所以每个 action 都要自己守门，
 * 不能假设「用户在 /admin 页面里所以一定是管理员」。
 */
export async function renderPreviewAction(
  markdown: string,
  kind: string,
): Promise<PreviewResult> {
  await requireAdmin();

  const safeKind: EntryKind = (["blog", "diary", "projects", "goals"] as const).includes(
    kind as EntryKind,
  )
    ? (kind as EntryKind)
    : "blog";

  // headingOffset 与写入时用的完全一致（goals 是 2，其余是 0），
  // 否则预览里的标题层级和发布后不一样，锚点也会对不上。
  const offset = safeKind === "goals" ? 2 : 0;

  return buildPreviewHtml(markdown, (md) => renderMarkdown(md, { headingOffset: offset }));
}
