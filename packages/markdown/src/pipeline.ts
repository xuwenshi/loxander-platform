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

/* -------------------------------------------------------------------------- */
/* 链接安全（方案 §13.2：危险协议 + 外链 rel）                                 */
/* -------------------------------------------------------------------------- */

/**
 * 会执行脚本、或能把当前页面变成一份「可注入文档」的协议。
 *
 * `data:` 不在这张表里：它对 `<a>` 与 `<img>` 的处置不同，见 `isUnsafeUrl` 的
 * `allowData` 参数。
 */
const UNSAFE_PROTOCOLS: readonly string[] = ['javascript', 'vbscript'];

/**
 * 视为「站内」的 host 白名单。**当前刻意留空**。
 *
 * 理由：正文里出现站点自身的绝对 URL，说明作者本可以用 `/path` 相对写法；
 * 一旦两者混用，改域名时正文会全部失效。留空意味着「任何 `http(s)://` 都按外链处理」，
 * 与方案 §13.2「正文里的外链一律加 rel」一致。若将来确有正文引用本站绝对 URL 的需要，
 * 把 host 加进这个数组即可，其余逻辑不用动。
 */
const SITE_HOSTS: readonly string[] = [];

/**
 * 外链要补的 rel。
 *
 * 只要 `noopener` 与 `noreferrer` 两个：
 * - `noopener`：阻断 `window.opener` 反向控制（老浏览器对 `<a target>` 的经典提权面）。
 * - `noreferrer`：不把本站 URL 作为 Referer 送给第三方。
 *
 * **不加 `target="_blank"`**：那会改变现有阅读行为（点外链会新开标签页），
 * 而方案 §13.2 只要求补 rel、没要求改跳转方式。安全收益来自 `noopener`，
 * 不是来自新标签页；擅自把用户的浏览习惯改掉，属于拿「顺手的加固」冒充需求。
 */
const EXTERNAL_REL: readonly string[] = ['noopener', 'noreferrer'];

/**
 * 取出 URL 的协议名（不含冒号，小写）；没有协议（相对路径、锚点、`mailto:` 之外的无冒号串）时返回 `undefined`。
 *
 * 归一化为什么这么做：
 * 1. **去空白与不可见字符**。`ja\nvascript:` 这类中间插空白/换行/零宽字符的写法，
 *    在部分历史浏览器里会被协议解析器「连起来」当作 `javascript:`。判定前先抹掉
 *    `\u0000-\u0020`、`\u007f`、`\u00a0`、`\u200b-\u200f`、`\u2028`、`\u2029`、`\ufeff`，
 *    保证「看起来不像一个协议」的串也会被正确识别成协议。
 * 2. **大小写不敏感**。`JaVaScRiPt:` 与 `javascript:` 等价，统一转小写再比。
 * 3. 只从**开头**取协议。`/a:b`、`./a:b`、`#a:b` 首字符不是字母，天然不匹配。
 *
 * 注：抹空白只作用于**判定用的副本**，绝不回写 `href` —— 改写用户链接目标是另一件事。
 */
function protocolOf(url: string): string | undefined {
  const normalized = url.replace(/[\u0000-\u0020\u007f\u00a0\u200b-\u200f\u2028\u2029\ufeff]/g, '');
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * 这个 URL 是否必须被降级。
 *
 * `allowData` 只有 `<img>` 为 `true`，理由见 `rehypeSafeLinks` 内注释。
 */
function isUnsafeUrl(url: string, allowData: boolean): boolean {
  const protocol = protocolOf(url);
  if (protocol === undefined) return false;
  if (UNSAFE_PROTOCOLS.includes(protocol)) return true;
  // `data:` 对 `<a>` 是危险协议（点击后进入一份由攻击者拼好的文档）。
  return protocol === 'data' && !allowData;
}

/** 取 host（小写）。解析失败返回 `undefined`。 */
function hostOf(url: string): string | undefined {
  try {
    // 第二个参数只用于补全协议相对地址（`//example.com/x`），本身不会出现在结果里
    return new URL(url, 'https://site.invalid').hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * 是否是外链。
 *
 * 判定口径：
 * - `http://` / `https://` 开头（大小写不敏感）——`HTTPS://Example.com` 同样是外链；
 * - 协议相对地址 `//example.com/x` 也算——浏览器会用当前页协议补全它，跳转结果与
 *   `https://example.com/x` 完全一样，只在比较字符串时「看起来像内链」，不处理就是漏网；
 * - host 命中 `SITE_HOSTS` 的不算外链。
 *
 * host 解析不出来时**按外链处理**：补一个多余的 rel 只损失同站 Referer（可忽略），
 * 漏掉一个该有的 rel 则是安全缺陷。两类错误代价不对称，因此偏向保守。
 */
function isExternalUrl(url: string): boolean {
  const trimmed = url.trim();
  const isAbsoluteHttp = /^https?:\/\//i.test(trimmed);
  const isProtocolRelative = trimmed.startsWith('//');
  if (!isAbsoluteHttp && !isProtocolRelative) return false;

  const host = hostOf(trimmed);
  if (host === undefined) return true;

  return !SITE_HOSTS.some((site) => host === site || host.endsWith(`.${site}`));
}

/**
 * 链接安全插件（方案 §13.2 的两条要求：危险协议降级 + 外链补 rel）。
 *
 * ## 为什么是「去掉 href/src」而不是「删掉整个元素」
 *
 * 删元素会让正文语义断裂：`[点这里](javascript:...)` 删掉后句子少半截，读者看到的是
 * 残句；而 `<img>` 删掉则整段排版塌陷。去掉 URL 之后，链接退化成纯文本、图片退化成
 * 空占位——**信息量保留，攻击面归零**。再配一个 `data-unsafe-*` 标记，让「这里被
 * 清洗过」在 DOM 里可查（排查内容问题时不必靠猜），也方便测试断言。
 *
 * ## 为什么 `<img>` 的 `data:` 放行、`<a>` 的不放行
 *
 * - `<img>` 上下文**不能执行脚本**：浏览器把它当图片解码，`data:text/html` 不会被当作
 *   文档解析，SVG 在 `<img>` 里也是「脚本禁用」的（规范如此，不是浏览器实现细节）。
 * - 而 `next.config.ts:117` 的 CSP 就是 `img-src 'self' data: blob: ...`，
 *   两份配置必须说同一件事。若这里禁掉 `data:`，CSP 那边的允许就成了谎言，
 *   将来加内联小图标时会在「CSP 明明允许、渲染却说没 src」之间反复排查。
 * - `<a>` 的 `data:` 完全不同：点击会导航到一份由内容作者拼好的文档，
 *   这正是 XSS 要防的形态，所以对 `<a>` 一律禁止。
 *
 * ## 为什么不给内链加 rel
 *
 * `./a`、`/b`、`#c`、`mailto:d` 都是同站（或非导航）目标。给它们加 `noreferrer`
 * 会让站内跳转丢掉 Referer —— 反向链接统计、来源分析会全部失真；`noopener` 在
 * 同源跳转下也没有意义。**安全措施只在真的跨源时才该生效**，否则就是无差别加噪声。
 *
 * ## 为什么只处理 `a` / `img`
 *
 * 这条管线不允许裸 HTML 透传（`remarkRehype` 未开 `allowDangerousHtml`，实测
 * `<a href="javascript:...">` 与 `<img src="javascript:...">` 会整段被丢弃），
 * 因此 hast 里的 URL 载体**只可能**是 markdown 语法产出的 `a[href]` 与 `img[src]`。
 * `srcset`、`<video>`、`<source>` 这些在本管线里无从产生，不做假设性防御。
 */
function rehypeSafeLinks() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'a') {
        const href = node.properties.href;
        if (typeof href !== 'string') return;

        if (isUnsafeUrl(href, false)) {
          delete node.properties.href;
          node.properties['data-unsafe-href'] = 'removed';
          // 危险链接一律不做外链判定：没有 href 的 <a> 已经不可点击，再加 rel 没有意义
          return;
        }

        if (isExternalUrl(href)) {
          node.properties.rel = [...EXTERNAL_REL];
        }
        return;
      }

      if (node.tagName === 'img') {
        const src = node.properties.src;
        if (typeof src !== 'string') return;
        // alt 原样保留：它本来就不是可执行内容，删掉只会让读者失去图片说明
        if (isUnsafeUrl(src, true)) {
          delete node.properties.src;
          node.properties['data-unsafe-src'] = 'removed';
        }
      }
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
    // 位置要求：必须在 rehypeAutolinkHeadings 之后（否则标题锚点还没生成，漏检），
    // 且在 rehypeStringify 之前（属性必须落到最终输出上）。
    .use(rehypeSafeLinks)
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
    // 位置要求：必须在 rehypeAutolinkHeadings 之后（否则标题锚点还没生成，漏检），
    // 且在 rehypeStringify 之前（属性必须落到最终输出上）。
    .use(rehypeSafeLinks)
    .use(rehypeShikiFromHighlighter, shikiHighlighter(), SHIKI_OPTIONS)
    .use(rehypeCodeBlockLanguage)
    .use(rehypeStringify)
    .process(markdown);

  return String(file);
}
