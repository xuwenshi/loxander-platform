import { renderMarkdownSync } from '@loxander/markdown'
import DOMPurify from 'dompurify'

/**
 * 预览渲染：直接复用站点同一条渲染管线（`@loxander/markdown`）。
 *
 * 为什么改成共享包：
 * - 之前桌面端自己拼了一条简化管线（无 Shiki、无 TOC 锚点、无代码块语言包装），
 *   导致「编辑器里看到的」与「站点发布后看到的」不是同一份 HTML；
 * - 共享包的 `renderMarkdownSync` 与站点用的异步版本**逐字节等价**（有回归测试锁死），
 *   于是预览即真机效果。
 *
 * 仍然是**不信任内容**的：`remark-rehype` 不开 raw HTML（原文里的 `<script>` 会被丢弃），
 * 共享管线也不注入任何原始 HTML，结果再过一遍 DOMPurify 才交给 dangerouslySetInnerHTML。
 * DOMPurify 的白名单保留 `style` 属性，Shiki 的 `style="color:…;--shiki-dark:…"` 因此得以保留。
 *
 * 用同步版本的原因：`EditorPane` 在 `useMemo` 里同步取值，不能改成 Promise。
 */
export function renderMarkdown(markdown: string): string {
  const html = renderMarkdownSync(markdown)
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
