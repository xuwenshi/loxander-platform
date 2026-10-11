import type { DiffLine } from '../../../preload/api'

/** 行级差异展示：dry-run 预览与冲突裁决共用 */
export default function DiffView({ lines }: { lines: DiffLine[] }) {
  const changed = lines.filter((line) => line.type !== 'equal')
  if (changed.length === 0) {
    return <p className="hint">与磁盘版本一致，没有差异。</p>
  }
  return (
    <div className="diff">
      {lines.map((line, index) => (
        <div key={index} className={`diff-line ${line.type}`}>
          <span className="diff-no">{line.aLine ?? ''}</span>
          <span className="diff-no">{line.bLine ?? ''}</span>
          <span className="diff-sign">
            {line.type === 'insert' ? '+' : line.type === 'delete' ? '-' : ' '}
          </span>
          <span className="diff-text">{line.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}