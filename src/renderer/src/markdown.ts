import DOMPurify from 'dompurify'
import rehypeSlug from 'rehype-slug'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'

/**
 * 预览渲染：与站点同源的 unified/remark/rehype 管线，但**不信任内容**——
 * remark-rehype 不开启 raw HTML（原文里的 <script> 会被丢弃），
 * 结果再过一遍 DOMPurify，双重保护后才交给 dangerouslySetInnerHTML。
 *
 * 代码高亮（Shiki）按计划留到后续以「懒加载 + 异步补高亮」方式接入，避免 P1 首屏变慢。
 */

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSlug)
  .use(rehypeStringify)

export function renderMarkdown(markdown: string): string {
  const html = String(processor.processSync(markdown))
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}