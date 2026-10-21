import { CmsError } from '../errors'
import {
  assembleDocument,
  detectEol,
  splitLines,
  valuesEqual,
  type ParsedDocument
} from './frontmatterService'

/**
 * 字段级 frontmatter patch（P1 核心）。
 *
 * 铁律：**只重写被编辑字段所在的行，其余字段与 Markdown 正文逐字节不变。**
 * 序列化风格刻意对齐现有 11 篇内容的书写习惯（双引号字符串、裸日期、行内数组、块状 milestones），
 * 因此「把当前值再 patch 一次」必须得到逐字节相同的文件（幂等，见 roundtrip 测试）。
 *
 * `null` 语义：patch 中某 key 的值为 `null` → 删除该字段（可选字段清空）。
 */

export interface Milestone {
  title: string
  done: boolean
}

export type FrontmatterPatch = Record<string, unknown>

export interface PatchChange {
  key: string
  kind: 'update' | 'add' | 'remove'
  /** 变更前的原文形态（行内值或整块文本）；新增为 null */
  from: string | null
  /** 变更后的原文形态；删除为 null */
  to: string | null
}

export interface PatchOutcome {
  /** 装配后的完整文件文本 */
  text: string
  /** 装配后的 frontmatter 原文 */
  frontmatterRaw: string
  changes: PatchChange[]
  changed: boolean
}

interface WorkLine {
  text: string
  eol: string
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:([ \t]*)(.*)$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isMilestoneArray(value: unknown): value is Milestone[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Milestone).title === 'string' &&
        typeof (item as Milestone).done === 'boolean'
    )
  )
}

/** 字符串标量的书写形态：日期保持裸值（与现有内容一致），其余用双引号 */
function serializeString(value: string): string {
  if (DATE_RE.test(value)) return value
  return JSON.stringify(value)
}

function serializeScalar(value: unknown): string {
  if (typeof value === 'string') return serializeString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (value === null || value === undefined) return 'null'
  throw new CmsError('INVALID_FIELD', `无法序列化的字段值类型：${typeof value}`)
}

function serializeStringArray(value: unknown[]): string {
  return `[${value.map((item) => serializeString(String(item))).join(', ')}]`
}

function milestoneLines(value: Milestone[], eol: string): WorkLine[] {
  const out: WorkLine[] = []
  for (const item of value) {
    out.push({ text: `  - title: ${serializeString(item.title)}`, eol })
    out.push({ text: `    done: ${item.done ? 'true' : 'false'}`, eol })
  }
  return out
}

/** 把一个字段值转成「该字段在 YAML 中应有的所有行」 */
function buildLines(key: string, value: unknown, eol: string): WorkLine[] {
  if (isMilestoneArray(value)) {
    const block = milestoneLines(value, eol)
    // 空数组退化为行内 `[]`，避免出现「key: 后面什么都没有」的非法块
    if (block.length === 0) return [{ text: `${key}: []`, eol }]
    return [{ text: `${key}:`, eol }, ...block]
  }
  if (Array.isArray(value)) return [{ text: `${key}: ${serializeStringArray(value)}`, eol }]
  return [{ text: `${key}: ${serializeScalar(value)}`, eol }]
}

/** 该字段在原文中应被整体替换的文本形态（用于变更记录与幂等比较） */
function blockTextOf(lines: WorkLine[]): string {
  return lines.map((line) => line.text + line.eol).join('')
}

/** 拆分行内注释（`#` 需前置空白才构成注释，且不能在引号内） */
function splitInlineComment(rest: string): { value: string; comment: string } {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble && i > 0 && /[ \t]/.test(rest[i - 1])) {
      let cstart = i
      while (cstart > 0 && /[ \t]/.test(rest[cstart - 1])) cstart--
      return { value: rest.slice(0, cstart), comment: rest.slice(cstart) }
    }
  }
  return { value: rest, comment: '' }
}

function findKeyIndex(work: WorkLine[], key: string): number {
  for (let i = 0; i < work.length; i++) {
    const m = KEY_RE.exec(work[i].text)
    if (m && m[1] === key) return i
  }
  return -1
}

/** 块值（key 后为空）的结束下标：连续的空行或缩进行算作块体 */
function blockEnd(work: WorkLine[], idx: number): number {
  let j = idx + 1
  while (j < work.length) {
    const text = work[j].text
    if (text.trim() === '' || /^[ \t]/.test(text)) {
      j++
      continue
    }
    break
  }
  while (j - 1 > idx && work[j - 1].text.trim() === '') j--
  return j
}

function ensureTrailingEol(work: WorkLine[], eol: string): void {
  if (work.length === 0) return
  const last = work[work.length - 1]
  if (last.eol === '') last.eol = eol
}

/**
 * 对 frontmatter 施加字段级 patch。
 * 顺序策略：先按「文档中出现顺序」处理已有 key，再追加新 key（保持其它字段字节不动）。
 */
export function patchFrontmatter(doc: ParsedDocument, patch: FrontmatterPatch): PatchOutcome {
  const eol = detectEol(doc.hasFrontmatter ? doc.frontmatterRaw || doc.fullText : doc.fullText)
  const work: WorkLine[] = doc.hasFrontmatter
    ? splitLines(doc.frontmatterRaw).map((line) => ({ text: line.text, eol: line.eol }))
    : []

  const existingKeys = work
    .map((line) => KEY_RE.exec(line.text)?.[1])
    .filter((key): key is string => Boolean(key))
  const orderedKeys = [
    ...existingKeys.filter((key) => key in patch),
    ...Object.keys(patch).filter((key) => !existingKeys.includes(key))
  ]

  const changes: PatchChange[] = []

  for (const key of orderedKeys) {
    const value = patch[key]
    const idx = findKeyIndex(work, key)

    // 删除字段：值为 null/undefined，且原文中存在
    if (value === null || value === undefined) {
      if (idx === -1) continue
      const end = blockEnd(work, idx)
      const from = blockTextOf(work.slice(idx, end))
      work.splice(idx, end - idx)
      changes.push({ key, kind: 'remove', from, to: null })
      continue
    }

    // 新增字段
    if (idx === -1) {
      ensureTrailingEol(work, eol)
      const added = buildLines(key, value, eol)
      work.push(...added)
      changes.push({ key, kind: 'add', from: null, to: blockTextOf(added) })
      continue
    }

    // 更新字段
    const m = KEY_RE.exec(work[idx].text)!
    const prefix = `${m[1]}:${m[2] || ' '}`
    const rest = m[3]
    const end = rest.trim() === '' ? blockEnd(work, idx) : idx + 1
    const currentText = blockTextOf(work.slice(idx, end))

    let next: WorkLine[]
    if (rest.trim() === '') {
      // 原为块值 → 目标形态可能是行内或块
      next = buildLines(key, value, eol)
    } else {
      const { comment } = splitInlineComment(rest)
      if (isMilestoneArray(value)) {
        next = buildLines(key, value, eol)
      } else {
        const serialized = Array.isArray(value)
          ? serializeStringArray(value)
          : serializeScalar(value)
        // 原值本身就是块形态但目标是标量：直接改为行内
        next = [{ text: `${prefix}${serialized}${comment}`, eol: work[idx].eol || eol }]
      }
    }

    const nextText = blockTextOf(next)
    if (nextText === currentText) continue
    work.splice(idx, end - idx, ...next)
    changes.push({ key, kind: 'update', from: currentText, to: nextText })
  }

  const frontmatterRaw = work.map((line) => line.text + line.eol).join('')
  return {
    text: assembleDocument(doc, frontmatterRaw),
    frontmatterRaw,
    changes,
    changed: changes.length > 0
  }
}

/**
 * 仅计算 patch 结果，不落盘（dry-run，供 dirtyDiff 使用）。
 * 返回 `skipped`：语义未变而被跳过的字段（避免制造格式化噪声）。
 */
export function planPatch(
  doc: ParsedDocument,
  patch: FrontmatterPatch
): PatchOutcome & { skipped: string[] } {
  const skipped: string[] = []
  const effective: FrontmatterPatch = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      effective[key] = value as unknown
      continue
    }
    if (Object.prototype.hasOwnProperty.call(doc.data, key) && valuesEqual(doc.data[key], value)) {
      skipped.push(key)
      continue
    }
    effective[key] = value
  }
  const outcome = patchFrontmatter(doc, effective)
  return { ...outcome, skipped }
}

/**
 * 降级路径：整份 frontmatter 重新序列化（会丢失原始引号风格/注释）。
 * 仅在字段级 patch 不可用时使用，且**必须**先给用户看 diff 并人工确认；
 * P1 中它只用于 dirtyDiff 的预览，不参与默认保存链路。
 */
export function serializeFullDocument(
  doc: ParsedDocument,
  data: Record<string, unknown>,
  keys: string[],
  eol?: string
): string {
  const lineEnding = eol ?? detectEol(doc.fullText)
  const ordered = [
    ...keys.filter((key) => key in data && data[key] !== undefined),
    ...Object.keys(data).filter((key) => !keys.includes(key))
  ]
  const lines: WorkLine[] = []
  for (const key of ordered) {
    const value = data[key]
    if (value === null || value === undefined) continue
    lines.push(...buildLines(key, value, lineEnding))
  }
  return assembleDocument(doc, lines.map((line) => line.text + line.eol).join(''))
}