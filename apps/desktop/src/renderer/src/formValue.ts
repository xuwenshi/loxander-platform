import type { FieldSpec } from '../../preload/api'

/** 表单值 ↔ frontmatter 值 的转换（renderer 侧唯一入口，避免各处自行拼装 patch） */

export type Milestone = { title: string; done: boolean }

function toDateString(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString().slice(0, 10)
  if (typeof raw === 'string') return raw.slice(0, 10)
  return ''
}

function isMilestoneArray(raw: unknown): raw is Milestone[] {
  return (
    Array.isArray(raw) &&
    raw.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Milestone).title === 'string' &&
        typeof (item as Milestone).done === 'boolean'
    )
  )
}

/** frontmatter 原始值 → 表单值 */
export function formValueOf(spec: FieldSpec, raw: unknown): unknown {
  switch (spec.kind) {
    case 'date':
      return toDateString(raw)
    case 'boolean':
      return raw === true
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : spec.fallback ?? 0
    case 'stringArray':
      return Array.isArray(raw) ? raw.map((item) => String(item)) : []
    case 'milestones':
      return isMilestoneArray(raw) ? raw.map((item) => ({ title: item.title, done: item.done })) : []
    default:
      return raw === undefined || raw === null ? '' : String(raw)
  }
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * 表单值 → patch 值。
 * 约定：可选字段被清空 → 返回 `null`，表示从 frontmatter 中删除该字段（而非写成空串）。
 */
export function patchValueOf(spec: FieldSpec, formValue: unknown): unknown {
  if (isEmpty(formValue)) {
    return spec.required ? formValue ?? '' : null
  }
  switch (spec.kind) {
    case 'date':
      return String(formValue).slice(0, 10)
    case 'boolean':
      return formValue === true
    case 'number': {
      const num = typeof formValue === 'number' ? formValue : Number(formValue)
      return Number.isFinite(num) ? num : spec.fallback ?? 0
    }
    case 'stringArray':
      return (formValue as unknown[]).map((item) => String(item)).filter((item) => item.trim() !== '')
    case 'milestones':
      return (formValue as Milestone[]).map((item) => ({ title: String(item.title), done: item.done === true }))
    default:
      return String(formValue)
  }
}

export function buildBaseline(schema: { fields: FieldSpec[] }, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const spec of schema.fields) out[spec.key] = formValueOf(spec, data[spec.key])
  return out
}

/** 只把「与基线不同」的字段转成 patch */
export function buildPatch(
  schema: { fields: FieldSpec[] },
  fields: Record<string, unknown>,
  baseline: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const spec of schema.fields) {
    const next = fields[spec.key]
    if (JSON.stringify(next) === JSON.stringify(baseline[spec.key])) continue
    patch[spec.key] = patchValueOf(spec, next)
  }
  return patch
}