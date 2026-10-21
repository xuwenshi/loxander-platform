/**
 * 从 Markdown 提取目录（TOC）。
 *
 * ## 为什么不能直接在 mdast 上算 slug
 *
 * 目录里的 `id` 必须与正文 HTML 里标题的 `id` **完全一致**，否则点击目录会跳空。
 * 正文 id 是 `rehype-slug` 生成的，而 `rehype-slug` 工作在 **hast**（HTML 树）上；
 * 若我们在 **mdast**（Markdown 树）上自己算 slug，两者对「标题里有什么」的判断不同，
 * 遇到行内 raw HTML 就会错位。实测三个反例（左侧是现状算错的值，右侧是 HTML 实际 id）：
 *
 * | Markdown                | 现状 TOC（mdast 算）      | HTML 实际 id（hast 算） |
 * | ----------------------- | ------------------------- | ----------------------- |
 * | `## a <!-- c --> b`     | `a----c----b`             | `a--b`                  |
 * | `## Title <span>x</span> tail` | `title-spanxspan-tail` | `title-x-tail`        |
 * | `## Title <br> tail`    | `title-br-tail`           | `title--tail`           |
 *
 * 根因：mdast 里行内 HTML 是 `html` 节点，`nodeToText` 递归不到它的「值」；
 * 转成 hast 后它变成 `raw` 节点，`rehype-slug` 的 `toString` 会把注释/空标签丢掉、
 * 把元素标签名丢掉，只留可见文本。
 *
 * ## 现在的做法
 *
 * 走与渲染**同一条** `remarkRehype` 转换，再交给**同一个** `rehype-slug` 插件写 id，
 * 然后直接读它写好的 `properties.id`。这样目录与正文不可能再错位 ——
 * 不是「两处逻辑写得一样」，而是「只有一处逻辑」。
 */

import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { toString as hastToString } from 'hast-util-to-string';
import type { Element, Root as HastRoot } from 'hast';

/** 一个目录项。 */
export interface TocItem {
  /** 与正文标题 `id` 一致，用于锚点跳转。 */
  id: string;
  /** 标题的可见文本。 */
  text: string;
  /** 2 = h2，3 = h3。 */
  level: number;
}

/**
 * 提取 h2 / h3 目录。
 *
 * 只收 h2/h3：h1 是页面标题（一篇文章只有一个），h4 及以下太细，
 * 放进目录反而降低可扫读性。
 */
export function extractHeadings(markdown: string): TocItem[] {
  const mdast = unified().use(remarkParse).use(remarkGfm).parse(markdown);

  // mdast → hast。这里必须用与渲染相同的 remarkRehype（含同样的默认行为），
  // 否则标题里的行内代码、链接等会转出不同的文本。
  const hast = unified().use(remarkRehype).runSync(mdast) as HastRoot;

  // rehype-slug 就地给 h1~h6 写 id。注意它按文档顺序对**所有**标题编号，
  // 所以我们只需读结果，不能自己另起一个 slugger 跳过某些层级。
  unified().use(rehypeSlug).runSync(hast);

  const items: TocItem[] = [];

  visit(hast, 'element', (node: Element) => {
    const match = /^h([1-6])$/.exec(node.tagName);
    if (!match) return;

    const level = Number(match[1]);
    if (level !== 2 && level !== 3) return;

    const id = node.properties.id;
    if (typeof id !== 'string' || id === '') return;

    items.push({ id, text: hastToString(node).trim(), level });
  });

  return items;
}
