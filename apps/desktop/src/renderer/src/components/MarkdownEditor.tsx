import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view'

/**
 * CodeMirror 6 编辑器（ADR-3）。
 * 依赖只取 package.json 里已声明的 @codemirror/* 子包，不用 `codemirror` 元包（未安装）。
 */

const darkTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: '#e6e9ef', height: '100%' },
    '.cm-content': { fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', fontSize: '12.5px' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#6b7280', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#ffffff0d' },
    '.cm-activeLineGutter': { backgroundColor: '#ffffff0d' },
    '&.cm-focused': { outline: 'none' }
  },
  { dark: true }
)

interface Props {
  value: string
  onChange: (value: string) => void
}

export default function MarkdownEditor({ value, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const changeRef = useRef(onChange)
  changeRef.current = onChange

  useEffect(() => {
    if (!host.current) return
    const instance = new EditorView({
      parent: host.current,
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
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changeRef.current(update.state.doc.toString())
          }),
          darkTheme
        ]
      })
    })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
    // 只在挂载时创建一次；外部 value 变化由下面的 effect 同步
  }, [])

  useEffect(() => {
    const instance = view.current
    if (!instance) return
    const current = instance.state.doc.toString()
    if (current === value) return
    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div className="editor" ref={host} />
}