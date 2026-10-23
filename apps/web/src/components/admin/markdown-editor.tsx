"use client";

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

/**
 * Markdown 编辑器（CodeMirror 6）。
 *
 * ── 为什么只依赖 `@codemirror/*` 子包 ─────────────────────────────────
 * `codemirror` 元包没有安装，而 `apps/desktop` 早就在用这套子包组合
 * （`apps/desktop/src/renderer/src/components/MarkdownEditor.tsx`）。
 * 直接复用同一组扩展，后台与桌面端的编辑手感一致。
 *
 * ── 为什么用受控但非「每次输入都 setState」的写法 ──────────────────────
 * 把 doc 每次变更都灌回 React state，会让整棵树（含预览区）每敲一个字符
 * 重渲染一次。这里改成：
 * - 挂载时用 `value` 建实例；
 * - 文档变化时**只**通过 `onChange` 往上报，由父组件决定节流（预览用）；
 * - 外部 `value` 真的变了（比如恢复历史版本后重填）才 dispatch 回编辑器。
 * 第三条用 `if (current === value) return` 判断，避免「上报 → 回灌 → 再上报」
 * 的死循环。
 */
export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 供 `<label htmlFor>` 关联，保证键盘用户能聚焦到编辑区。 */
  id?: string;
  /** 只读模式（查看历史版本时用）。 */
  readOnly?: boolean;
}

/**
 * 主题用 CSS 变量而不是硬编码色值。
 *
 * CodeMirror 的 `EditorView.theme` 生成的是真实 CSS 类，能读到
 * `globals.css` 里定义的 `--foreground` / `--surface` 等令牌，
 * 于是编辑器自动跟随明暗模式，不需要 JS 判断当前主题。
 */
const siteTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
    height: "100%",
    fontSize: "13px",
  },
  ".cm-content": {
    fontFamily: "var(--font-geist-mono), ui-monospace, Consolas, monospace",
    padding: "12px 0",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-deep)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 6%, transparent)" },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--accent) 6%, transparent)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto" },
});

export function MarkdownEditor({ value, onChange, id, readOnly = false }: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // 用 ref 存回调，避免 onChange 换新引用时重建编辑器（会丢光标位置）。
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const instance = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          bracketMatching(),
          indentOnInput(),
          foldGutter(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          markdown(),
          EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changeRef.current(update.state.doc.toString());
          }),
          siteTheme,
        ],
      }),
    });

    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
    // 只在挂载时建一次；`value` / `readOnly` 的后续变化由下面的 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const current = instance.state.doc.toString();
    if (current === value) return;
    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div id={id} ref={host} className="h-full min-h-[420px] w-full" />;
}
