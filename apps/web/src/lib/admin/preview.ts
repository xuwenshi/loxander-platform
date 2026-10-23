import "server-only";

import type { Schema } from "hast-util-sanitize";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";

/**
 * 后台预览的净化管线（方案 §9.4）。
 *
 * ── 为什么不能直接复用 `@loxander/markdown` 的 `renderMarkdown` ─────────
 * 那个管线是**站点渲染的唯一真相**，它的输出逐字节决定线上页面。
 * 在它里面插一层 sanitize 会改变已发布文章的外观（Shiki 输出的
 * `<pre class="shiki github-light" style="...">` 需要 `style` 与大量 `class`，
 * 默认 schema 会把这些剥掉，正文立刻变成无高亮的原始代码）。
 *
 * 所以这里做的是「渲染仍然走共享管线，**渲染完之后**再净化」：
 *
 *   markdown --renderMarkdown()--> HTML ----rehypeParse----> hast
 *        --rehypeSanitize(后台专用 schema)--> hast --rehypeStringify--> HTML
 *
 * 这样预览与线上看到的是同一份渲染结果，只是预览多过一道过滤器；
 * 而线上页面完全不受影响。
 *
 * ── 为什么还要 DOMPurify ───────────────────────────────────────────────
 * 方案 §9.4 要求「rehype-sanitize → DOMPurify」两道。两道都在服务端跑的理由：
 * 预览 HTML 最终要交给 `dangerouslySetInnerHTML`。hast 层的 sanitize 只能校验
 * 它看得懂的节点；万一 `rehypeStringify` 的序列化、或者未来某天换了解析器，
 * 还有一道基于**字符串**的检查兜底。DOMPurify 不依赖 React、不依赖 DOM 树，
 * 它在 jsdom 缺失时会把所有内容判为脏 —— 这里刻意用 `isSupported` 判断，
 * 不支持就**直接拒绝预览**（返回错误提示），而不是静默放行原始 HTML。
 */

/**
 * 后台预览专用 schema = GitHub 默认 schema + 三处放宽。
 *
 * 放宽的理由都是「共享管线自己就会产出这些属性」，不是为了让内容能写更多 HTML：
 *
 * 1. `pre` / `code` / `span` 允许 `className`、`style`
 *    —— Shiki 把颜色写在行内 `style` 上，class 用来承载双主题切换
 *       （`github-light` / `github-dark` 两套变量）。剥掉就等于关掉高亮。
 * 2. `h1`~`h6` 允许 `id` 与 `a` 子元素的 `className: heading-anchor`
 *    —— `rehypeSlug` + `rehypeAutolinkHeadings` 的产物，剥掉会让目录锚点全断。
 * 3. `div` 允许 `dataLanguage`、`className: code-block` / `contains-task-list`
 *    —— `rehypeCodeBlockLanguage` 与 GFM 任务列表的产物。
 *
 * 仍然**不放宽**任何危险能力：`script` / `iframe` / `object` / `embed` 不在
 * tagNames 里；`on*` 事件属性不在任何 attributes 白名单里；`style` 只在
 * `pre`/`code`/`span` 上开放（这三个元素上的 style 无法执行脚本，
 * 且 DOMPurify 那一道还会再过一遍）。
 */
const shikiClassPattern = /^(shiki|astro-code|language-|github-(light|dark)[\w-]*|code-block|line|highlighted|diff|add|remove)/;

/** 收紧 schema 里 `[名字, 允许值]` 这类二元组的类型，避免被推成 `(string|RegExp)[]`。 */
type PropertyDefinition = NonNullable<Schema["attributes"]>[string][number];

const classNameShiki: PropertyDefinition = ["className", shikiClassPattern];
const classNameHeadingAnchor: PropertyDefinition = ["className", /^heading-anchor$/];
const classNameCodeBlock: PropertyDefinition = [
  "className",
  /^(code-block|contains-task-list|footnotes)$/,
];

/** 取默认 schema 里某个标签已允许的属性（不存在则空数组）。 */
function baseAttrs(tagName: string): PropertyDefinition[] {
  return defaultSchema.attributes?.[tagName] ?? [];
}

export const adminPreviewSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    pre: [...baseAttrs("pre"), "className", "style", "tabIndex"],
    code: [...baseAttrs("code"), classNameShiki, "style"],
    span: [...baseAttrs("span"), classNameShiki, "style"],
    div: [...baseAttrs("div"), classNameCodeBlock, "dataLanguage"],
    h1: [...baseAttrs("h1"), "id"],
    h2: [...baseAttrs("h2"), "id"],
    h3: [...baseAttrs("h3"), "id"],
    h4: [...baseAttrs("h4"), "id"],
    h5: [...baseAttrs("h5"), "id"],
    h6: [...baseAttrs("h6"), "id"],
    a: [...baseAttrs("a"), classNameHeadingAnchor],
    // 封面图来自 public/ 或外链，尺寸属性用于避免布局抖动。
    img: [...baseAttrs("img"), "width", "height", "loading", "decoding"],
  },
  // 锚点 id 需要保持原文（`user-content-` 前缀会把目录链接全部打断）。
  // 关闭 clobber 前缀的风险：`id` 冲突只影响锚点跳转，不影响安全 ——
  // 真正的 XSS 面在能执行脚本的元素与属性上，这里一个都没放开。
  clobberPrefix: "",
};

/**
 * 净化 HTML 字符串。内部先 parse 成 hast，再 sanitize，再 stringify。
 *
 * 导出是给测试用的：`buildPreviewHtml` 的第二道 DOMPurify 依赖 jsdom，
 * 而「hast 层 schema 到底放行了什么、剥掉了什么」是第一道防线的全部内容，
 * 必须能被单独断言，否则安全规则只能靠肉眼看源码。
 */
export function sanitizeHtml(html: string): string {
  const file = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize, adminPreviewSchema)
    .use(rehypeStringify)
    .processSync(html);

  return String(file);
}

/* -------------------------------------------------------------------------- */
/* DOMPurify（第二道）                                                         */
/* -------------------------------------------------------------------------- */

/**
 * DOMPurify 在 Node 下需要 DOM 实现。这里**懒加载**并缓存结果：
 * - 加载成功 → 用真的 DOMPurify 再过一遍；
 * - 加载失败（缺 jsdom 之类）→ 记录一次告警，后续预览**直接报错**，
 *   绝不放行未净化的 HTML。
 *
 * 之所以不用 `dompurify` 的 `minimal` 之类便捷入口：它默认导出在 Node 下
 * 是「无 window 的工厂函数」，直接调用会抛 `isSupported === false`。
 */
type Purifier = (html: string) => string;

let purifierPromise: Promise<Purifier> | undefined;

async function loadPurifier(): Promise<Purifier> {
  const { JSDOM } = await import("jsdom");
  const { default: createDOMPurify } = await import("dompurify");

  const { window } = new JSDOM("");
  // jsdom 的 Window 与 DOMPurify 声明的 `WindowLike` 不是同一套结构类型
  // （前者来自 @types/jsdom、后者是 dompurify 自己声明的最小接口），
  // 运行时是同一个对象，类型层需要一次显式断言。
  type PurifyWindow = NonNullable<Parameters<typeof createDOMPurify>[0]>;
  const purify = createDOMPurify(window as unknown as PurifyWindow);

  return (html: string) =>
    purify.sanitize(html, {
      // 与 hast 层 schema 保持一致：允许 Shiki 的行内 style 与 class。
      ADD_ATTR: ["style", "dataLanguage", "target"],
      ADD_TAGS: ["picture", "source"],
      // 明确禁止：脚本、内联框架、表单、事件属性。
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
      // 保留 id，目录锚点依赖它。
      KEEP_CONTENT: true,
    });
}

function getPurifier(): Promise<Purifier> {
  purifierPromise ??= loadPurifier();
  return purifierPromise;
}

/* -------------------------------------------------------------------------- */
/* 对外                                                                        */
/* -------------------------------------------------------------------------- */

export interface PreviewResult {
  ok: boolean;
  /** 净化成功的 HTML；`ok=false` 时为 undefined。 */
  html?: string;
  /** 失败原因。UI 直接显示给编辑者。 */
  error?: string;
}

/**
 * 把 Markdown 渲染成**可安全注入**的预览 HTML。
 *
 * `render` 由调用方传入（即 `@loxander/markdown` 的 `renderMarkdown`），
 * 这样这个模块不需要知道 headingOffset / 主题等站点选项 —— 调用方用哪一套，
 * 预览就跟哪一套完全一致。
 */
export async function buildPreviewHtml(
  markdown: string,
  render: (markdown: string) => Promise<string>,
): Promise<PreviewResult> {
  let raw: string;
  try {
    raw = await render(markdown);
  } catch (error) {
    return {
      ok: false,
      error: `Markdown 渲染失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let sanitized: string;
  try {
    sanitized = sanitizeHtml(raw);
  } catch (error) {
    return {
      ok: false,
      error: `HTML 净化失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const purify = await getPurifier();
    return { ok: true, html: purify(sanitized) };
  } catch (error) {
    // 第二道过滤器不可用时，宁可让预览报错也不让未过滤的 HTML 上去。
    console.error("[admin/preview] DOMPurify 不可用，已拒绝预览：", error);
    return {
      ok: false,
      error:
        "DOMPurify 不可用（缺少 jsdom），预览已被拒绝。" +
        "为了不让未净化的 HTML 进入页面，这里不会降级放行。",
    };
  }
}
