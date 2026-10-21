/**
 * 共享 Markdown 渲染管线。
 *
 * 本包存在的理由：站点（apps/web）与桌面端（apps/desktop）此前各自维护一份
 * unified/remark/rehype 管线，两边差异会直接变成「同一篇 Markdown 预览与线上不一致」。
 * 现在两边共用这一个文件，差异只允许通过选项（`headingOffset`）表达。
 *
 * ## 为什么用 `rehypeShikiFromHighlighter` 而不是 `rehypeShiki`
 *
 * `rehypeShiki`（`@shikijs/rehype` 默认导出）内部是异步的：它用
 * `getSingletonHighlighter` 惰性加载 grammar，因此只能配 `process()`，无法 `processSync()`。
 * Desktop 的预览面板在 `useMemo` 里同步渲染，需要同步版本。
 *
 * 若同步路径另建一个 highlighter，两边就可能因为加载的 grammar / 选项不同而产生
 * 细微差异。所以这里让两条路径**共用同一个 highlighter 实例**（`getHighlighter()`），
 * 差异只剩 `process` 与 `processSync` —— 输出因此逐字节相同。
 */

import rehypeShikiFromHighlighter, { type RehypeShikiCoreOptions } from '@shikijs/rehype/core';
import type { HighlighterGeneric } from '@shikijs/types';
import type { Element, Root as HastRoot } from 'hast';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import { getHighlighter, THEME_DARK, THEME_LIGHT } from './highlighter';

/**
 * `rehypeShikiFromHighlighter` 形参的类型（`HighlighterGeneric<any, any>`）。
 *
 * 为什么不直接传 `HighlighterCore`：`HighlighterCore` 是 `HighlighterGeneric<never, never>`
 * 的别名，而 `never` 不能赋给 `any`（`HighlighterGeneric` 的成员签名对泛型做了逆变处理），
 * 于是「更具体」的类型反而通不过「更宽泛」的形参 —— 纯类型层的人工障碍，
 * 运行时是同一个对象。断言因此集中在这一个函数里，而不是散落在每个 `.use()` 调用处。
 */
type ShikiTransformerHighlighter = HighlighterGeneric<any, any>;

/** 取用于 rehype 的 highlighter 实例（唯一的类型断言点）。 */
function shikiHighlighter(): ShikiTransformerHighlighter {
  return getHighlighter() as ShikiTransformerHighlighter;
}

/** 渲染选项。目前只有标题层级偏移一项。 */
export interface RenderOptions {
  /**
   * 把标题整体下移 N 级。
   *
   * 用于 `/goals`：正文嵌在卡片里（分组标题 h2 → 卡片标题 h3），
   * 若正文里的 `##` 仍是 h2，大纲会变成「分组 h2 → 卡片 h3 → 正文 h2」的倒挂结构。
   */
  headingOffset?: number;
}

/**
 * 给代码块加上语言标识。
 *
 * 读取 `<code class="language-xxx">`，把 xxx 写到外层容器的 data-language 上，
 * 由 CSS 通过 ::before 渲染成右上角的小标签。
 *
 * 额外包一层 div 而不是直接给 `<pre>` 加属性：`<pre>` 是横向滚动容器，
 * 绝对定位的标签会跟着内容一起滚走。
 */
function rehypeCodeBlockLanguage() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: Element, index, parent) => {
      if (node.tagName !== 'pre' || !parent || index === undefined) return;

      const code = node.children.find(
        (child): child is Element => child.type === 'element' && child.tagName === 'code',
      );
      if (!code) return;

      // Shiki 直接写入 hast 的 `class` 属性（而不是惯用的 `className`），两者都要兼容
      const raw = code.properties.className ?? code.properties.class;
      const classNames = Array.isArray(raw) ? raw.map(String) : [];
      const language = classNames
        .find((name) => name.startsWith('language-'))
        ?.slice('language-'.length);

      const wrapper: Element = {
        type: 'element',
        tagName: 'div',
        properties: {
          className: ['code-block'],
          ...(language && language !== 'plaintext' ? { dataLanguage: language } : {}),
        },
        children: [node],
      };

      parent.children[index] = wrapper;
    });
  };
}

/**
 * 把标题层级整体下移 N 级。
 *
 * 必须放在 rehypeSlug / rehypeAutolinkHeadings 之后：锚点 id 与锚点元素先按原文生成，
 * 之后只改标签名，链接与目录都保持稳定（锚点样式已覆盖 h1~h6）。
 */
function rehypeShiftHeadings(offset: number) {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: Element) => {
      const match = /^h([1-6])$/.exec(node.tagName);
      if (!match) return;
      node.tagName = `h${Math.min(6, Number(match[1]) + offset)}`;
    });
  };
}

/** 标题锚点插件的配置。抽成常量，保证两条路径、以及 TOC 提取都不走样。 */
const AUTOLINK_OPTIONS = {
  behavior: 'append' as const,
  // 内容留空，只保留一个可点击的锚点元素；可见的 "#" 由 CSS ::after 绘制。
  // 这样标题的 textContent 不会被一个「井号」污染（复制标题、读屏都不受影响），
  // 可访问名称仍然来自 aria-label。
  content: { type: 'text' as const, value: '' },
  properties: {
    className: ['heading-anchor'],
    ariaLabel: '本节链接',
  },
};

/** Shiki 高亮选项。与迁移前的 `apps/web/src/lib/markdown.ts` 完全一致。 */
const SHIKI_OPTIONS: RehypeShikiCoreOptions = {
  themes: {
    light: THEME_LIGHT,
    dark: THEME_DARK,
  },
  defaultColor: 'light',
  // 未加载 / 未知语言退化为纯文本，避免构建直接失败
  fallbackLanguage: 'plaintext',
  addLanguageClass: true,
  // 对比度修正（WCAG AA 正文 4.5:1）：只替换这两个不达标的颜色，其余令牌保持主题原貌。
  // 必须按主题分别给（键名 = 主题名）：同一个色值在两个主题里的达标情况不同，
  // 例如 #6a737d 在 github-light 的白底上是 4.82:1（合格），
  // 若写成全局替换会把它在浅色主题里改成更浅的 #8b949e，反而降到 3.08:1。
  colorReplacements: {
    'github-dark': {
      '#6a737d': '#8b949e', // 注释：3.05:1 → 4.77:1（底色 #24292e）
    },
    'github-light': {
      '#e36209': '#b45309', // 常量：3.49:1 → 5.02:1（底色 #ffffff）
    },
  },
};

/**
 * Markdown → HTML（同步）。
 *
 * 供桌面端预览使用：`useMemo` 里同步调用，不能返回 Promise。
 */
export function renderMarkdownSync(markdown: string, options: RenderOptions = {}): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, AUTOLINK_OPTIONS)
    .use(rehypeShiftHeadings, options.headingOffset ?? 0)
    .use(rehypeShikiFromHighlighter, shikiHighlighter(), SHIKI_OPTIONS)
    .use(rehypeCodeBlockLanguage)
    .use(rehypeStringify)
    .processSync(markdown);

  return String(file);
}

/**
 * Markdown → HTML（异步）。
 *
 * 供站点在构建期使用。与同步版共用 highlighter 与全部选项，
 * 因此两者输出逐字节相同（由 `__tests__/consistency.test.ts` 守护）。
 */
export async function renderMarkdown(
  markdown: string,
  options: RenderOptions = {},
): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, AUTOLINK_OPTIONS)
    .use(rehypeShiftHeadings, options.headingOffset ?? 0)
    .use(rehypeShikiFromHighlighter, shikiHighlighter(), SHIKI_OPTIONS)
    .use(rehypeCodeBlockLanguage)
    .use(rehypeStringify)
    .process(markdown);

  return String(file);
}
