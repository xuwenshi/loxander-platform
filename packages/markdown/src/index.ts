/**
 * `@loxander/markdown` —— 站点与桌面端共用的 Markdown 渲染管线。
 *
 * 拆成独立包的原因：这套管线原本在 `apps/web` 与 `apps/desktop` 各有一份，
 * 两份实现会随时间漂移，表现就是「后台预览与线上页面不一致」。
 * 共享之后差异只能通过选项表达，无法再悄悄分叉。
 *
 * 两个入口：
 * - `renderMarkdown`（异步）：站点构建期使用。
 * - `renderMarkdownSync`（同步）：桌面端预览在 `useMemo` 里同步调用，不能返回 Promise。
 *
 * 两者共用同一个 highlighter 与同一组选项，输出逐字节相同
 * （由 `src/__tests__/consistency.test.ts` 守护）。
 */

export { THEME_DARK, THEME_LIGHT, getHighlighter } from './highlighter';
export {
  renderMarkdown,
  renderMarkdownSync,
  type RenderOptions,
} from './pipeline';
export { extractHeadings, type TocItem } from './toc';
