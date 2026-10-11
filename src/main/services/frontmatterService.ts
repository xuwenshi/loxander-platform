import matter from 'gray-matter'

/**
 * frontmatter 读取层（P1）。
 *
 * 设计要点：**只读解析 + 逐字节保留原文**。
 * - `gray-matter` 仅用于拿到 `data`（供表单展示与校验），
 *   它的 `Date` 归一化、引号丢失等副作用一律不进写路径；
 * - 写路径依赖本模块给出的 `frontmatterRaw`（YAML 原文）与行偏移，
 *   由 contentPatchService 做字段级替换，未触碰字段保持逐字节不变。
 */

/** 一行文本及其在源串中的精确区间；`text` 不含换行符，`eol` 保留 `\n` 或 `\r\n` */
export interface FmLine {
  text: string
  eol: string
  /** 该行首字符在源串中的下标 */
  start: number
  /** 该行换行符之后的下标（下一行的 start） */
  end: number
}

export interface ParsedDocument {
  fullText: string
  hasFrontmatter: boolean
  /** 两个 `---` 分隔行之间的 YAML 原文（逐字节） */
  frontmatterRaw: string
  /** 闭合 `---` 行之后的所有内容（含该行的换行） */
  body: string
  /** 解析后的对象，仅供读取/校验；解析失败为空对象 */
  data: Record<string, unknown>
  dataError: string | null
  /** 全文按行切分（用于装配） */
  lines: FmLine[]
  /** 闭合 `---` 所在行号；无 frontmatter 时为 -1 */
  closeIndex: number
}

const DELIM = '---'

/** 按行切分并保留每行的精确偏移与换行符 */
export function splitLines(text: string): FmLine[] {
  const lines: FmLine[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue
    let end = i
    let eol = '\n'
    if (end > start && text[end - 1] === '\r') {
      end--
      eol = '\r\n'
    }
    lines.push({ text: text.slice(start, end), eol, start, end: i + 1 })
    start = i + 1
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), eol: '', start, end: text.length })
  }
  return lines
}

/** 探测文件主导换行符（默认 LF） */
export function detectEol(text: string): string {
  const idx = text.indexOf('\n')
  if (idx > 0 && text[idx - 1] === '\r') return '\r\n'
  return '\n'
}

/** 解析一篇 Markdown：拿原文切片 + 顺带解析 data。解析失败不抛错，退化为 dataError。 */
export function parseDocument(text: string): ParsedDocument {
  const lines = splitLines(text)
  const empty: ParsedDocument = {
    fullText: text,
    hasFrontmatter: false,
    frontmatterRaw: '',
    body: text,
    data: {},
    dataError: null,
    lines,
    closeIndex: -1
  }
  if (lines.length === 0 || lines[0].text.trim() !== DELIM) return empty

  let closeIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].text.trim() === DELIM) {
      closeIndex = i
      break
    }
  }
  if (closeIndex === -1) return empty

  const frontmatterRaw = text.slice(lines[0].end, lines[closeIndex].start)
  const body = text.slice(lines[closeIndex].end)

  let data: Record<string, unknown> = {}
  let dataError: string | null = null
  try {
    data = (matter(text).data as Record<string, unknown>) ?? {}
  } catch (err) {
    dataError = err instanceof Error ? err.message : String(err)
  }

  return { fullText: text, hasFrontmatter: true, frontmatterRaw, body, data, dataError, lines, closeIndex }
}

/**
 * 用新的 YAML 原文装配回完整文件；`body` 省略时沿用原文正文。
 * 无 frontmatter 时：`fmRaw` 为空 → 返回 `body ?? 原文`；非空 → 补出一对新分隔行（用于给裸 Markdown 补 frontmatter）。
 */
export function assembleDocument(doc: ParsedDocument, frontmatterRaw: string, body?: string): string {
  if (!doc.hasFrontmatter) {
    const nextBody = body ?? doc.fullText
    if (frontmatterRaw === '') return nextBody
    const eol = detectEol(doc.fullText)
    return `${DELIM}${eol}${frontmatterRaw}${DELIM}${eol}${nextBody}`
  }
  const openLine = doc.lines[0]
  const closeLine = doc.lines[doc.closeIndex]
  return `${openLine.text}${openLine.eol}${frontmatterRaw}${closeLine.text}${closeLine.eol}${body ?? doc.body}`
}

/** 列出 YAML 原文里的顶层 key（按出现顺序） */
export function topLevelKeys(frontmatterRaw: string): string[] {
  const keys: string[] = []
  for (const line of splitLines(frontmatterRaw)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:/.exec(line.text)
    if (m) keys.push(m[1])
  }
  return keys
}

/**
 * 把解析值归一为「与文件书写形态无关」的可比较值：
 * - `Date` → `YYYY-MM-DD`（规避时区偏移）
 * - 其余保持原样
 */
export function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    // 与站点 normalizeDate 对齐：一律取 UTC 前 10 位，避免本地时区导致差一天
    return value.toISOString().slice(0, 10)
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeValue(v)
    return out
  }
  return value
}

/** 深比较（数组顺序敏感），用于判断字段是否真的被改动 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  }
  return false
}

/** 语义比较：先归一（Date/嵌套），再深比较 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return deepEqual(normalizeValue(a), normalizeValue(b))
}