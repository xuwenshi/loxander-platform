/**
 * 单例 Shiki highlighter（同步版）。
 *
 * 为什么必须同步：Desktop 的预览面板在 `useMemo` 里同步渲染
 * （`apps/desktop/src/renderer/src/components/EditorPane.tsx:41-44`），
 * 不能改成 Promise。而 `createHighlighter`（异步）无法在同步上下文里 await。
 *
 * 因此这里用 `createHighlighterCoreSync` + `createJavaScriptRegexEngine`：
 * - `@shikijs/engine-oniguruma` 的 `createOnigurumaEngine` 返回 Promise，同步不可用；
 * - `createJavaScriptRegexEngine` 是纯同步的，且实测输出与异步引擎逐字节一致。
 *
 * 语言与主题全部**静态 import**：同步 API 拿不到 Promise，不能用 `await import()`。
 * 代价是这些 grammar 会进包，但它们本就是高亮必需的体积。
 *
 * 关键陷阱（实测）：`langs` 传空数组不会报错，而是让**所有语言退化成 plaintext**，
 * 高亮全部丢失且无明显报错。所以这里至少要把内容里真实用到的语言全部加载。
 */

import { createHighlighterCoreSync, type HighlighterCore } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';

// 主题
import themeDark from '@shikijs/themes/github-dark';
import themeLight from '@shikijs/themes/github-light';

// 语言：与 apps/web 内容实测用到的语言（python 16 / typescript 4 / text 2 / bash 1 / css 1 / html 1）
// 以及常见邻居语言一并加载，避免内容更新后高亮突然消失。
import langBash from '@shikijs/langs/bash';
import langCss from '@shikijs/langs/css';
import langDiff from '@shikijs/langs/diff';
import langDockerfile from '@shikijs/langs/dockerfile';
import langGo from '@shikijs/langs/go';
import langHtml from '@shikijs/langs/html';
import langJava from '@shikijs/langs/java';
import langJavascript from '@shikijs/langs/javascript';
import langJson from '@shikijs/langs/json';
import langJsx from '@shikijs/langs/jsx';
import langMarkdown from '@shikijs/langs/markdown';
import langPython from '@shikijs/langs/python';
import langRust from '@shikijs/langs/rust';
import langShellscript from '@shikijs/langs/shellscript';
import langSql from '@shikijs/langs/sql';
import langToml from '@shikijs/langs/toml';
import langTsx from '@shikijs/langs/tsx';
import langTypescript from '@shikijs/langs/typescript';
import langXml from '@shikijs/langs/xml';
import langYaml from '@shikijs/langs/yaml';

/** 静态加载的语言 grammar。顺序无关，Shiki 内部按 grammar 名索引。 */
const LANGS = [
  langBash,
  langCss,
  langDiff,
  langDockerfile,
  langGo,
  langHtml,
  langJava,
  langJavascript,
  langJson,
  langJsx,
  langMarkdown,
  langPython,
  langRust,
  langShellscript,
  langSql,
  langToml,
  langTsx,
  langTypescript,
  langXml,
  langYaml,
];

/** 主题名，与 `apps/web/src/lib/markdown.ts` 保持一致。 */
export const THEME_LIGHT = 'github-light';
export const THEME_DARK = 'github-dark';

let highlighter: HighlighterCore | undefined;

/**
 * 取同步高lighter 单例。
 *
 * 用惰性单例而不是模块顶层常量：高亮器初始化有成本（实测约 15–125ms），
 * 而 TOC 提取、纯文本预览等路径完全不需要高亮，不该为它们付出这个代价。
 */
export function getHighlighter(): HighlighterCore {
  if (!highlighter) {
    highlighter = createHighlighterCoreSync({
      themes: [themeLight, themeDark],
      langs: LANGS,
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighter;
}
