import { splitLines, valuesEqual } from './frontmatterService'

/**
 * 轻量行级 diff（LCS），用于：
 * - 保存前 dry-run 预览（区分「格式化噪声」与「真实内容差异」）；
 * - 冲突时并排展示「磁盘版本 vs 缓冲版本」。
 * 内容文件都在几百行内，O(n·m) 动态规划足够；不引入额外依赖。
 */

export interface DiffLine {
  type: 'equal' | 'insert' | 'delete'
  text: string
  /** 旧文件的 1-based 行号；insert 时为 null */
  aLine: number | null
  /** 新文件的 1-based 行号；delete 时为 null */
  bLine: number | null
}

export interface DiffSummary {
  added: number
  removed: number
  /** 仅对比 frontmatter 的解析结果得出：true 表示差异只来自书写形态，语义未变 */
  frontmatterFormatOnly: boolean
}

function lineTexts(text: string): string[] {
  return splitLines(text).map((line) => line.text)
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = lineTexts(oldText)
  const b = lineTexts(newText)
  const n = a.length
  const m = b.length

  // LCS 长度表
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'equal', text: a[i], aLine: i + 1, bLine: j + 1 })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'delete', text: a[i], aLine: i + 1, bLine: null })
      i++
    } else {
      out.push({ type: 'insert', text: b[j], aLine: null, bLine: j + 1 })
      j++
    }
  }
  while (i < n) out.push({ type: 'delete', text: a[i], aLine: ++i, bLine: null })
  while (j < m) out.push({ type: 'insert', text: b[j], aLine: null, bLine: ++j })
  return out
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.type === 'insert').length,
    removed: lines.filter((line) => line.type === 'delete').length
  }
}

/**
 * 判断 frontmatter 差异是否「只是格式化」：
 * 文本不同但两边解析出的数据语义相等 → 属格式化噪声，需在 UI 上区别对待。
 */
export function isFrontmatterFormatOnly(
  beforeData: Record<string, unknown>,
  afterData: Record<string, unknown>,
  beforeRaw: string,
  afterRaw: string
): boolean {
  if (beforeRaw === afterRaw) return false
  const keys = new Set([...Object.keys(beforeData), ...Object.keys(afterData)])
  for (const key of keys) {
    if (!valuesEqual(beforeData[key], afterData[key])) return false
  }
  return true
}

export function summarize(
  lines: DiffLine[],
  frontmatter: { beforeData: Record<string, unknown>; afterData: Record<string, unknown>; beforeRaw: string; afterRaw: string }
): DiffSummary {
  const stats = diffStats(lines)
  return {
    ...stats,
    frontmatterFormatOnly: isFrontmatterFormatOnly(
      frontmatter.beforeData,
      frontmatter.afterData,
      frontmatter.beforeRaw,
      frontmatter.afterRaw
    )
  }
}