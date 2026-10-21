import { CmsError } from '../errors'
import { normalizeValue } from './frontmatterService'
import { fieldSpec, schemaOf, type ContentSection, type FieldSpec } from './schemaService'

/**
 * 校验层（P1）：对齐基线 §6 的校验规则表。
 * - block：站点构建会失败 / 破坏构建，必须阻断保存或发布；
 * - warn：站点能跑但会静默降级（如封面尺寸优化失效），提示即可。
 *
 * 拆成「单字段校验 + 整表校验」两层：保存路径上只对本次 patch 涉及的字段做单字段校验，
 * 不会把「patch 里没带的必填字段」误判为缺失。
 */

export interface Issue {
  level: 'block' | 'warn'
  field?: string
  message: string
  hint?: string
}

export interface FieldValidation {
  blocking: Issue[]
  warnings: Issue[]
  /** 归一/夹取后的值（如 progress 夹到 0–100、Date → YYYY-MM-DD） */
  normalized?: unknown
}

export interface ValidationResult {
  blocking: Issue[]
  warnings: Issue[]
  ok: boolean
  normalized: Record<string, unknown>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const COVER_RE = /^\/.*\.svg$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 该值是否算「有效存在」（空串/空值视为缺失） */
export function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string' && value.trim() === '') return false
  return true
}

/** 单字段校验：只依据字段自己的 spec 判断，不涉及其它字段 */
export function validateField(spec: FieldSpec, raw: unknown, present = isPresent(raw)): FieldValidation {
  const blocking: Issue[] = []
  const warnings: Issue[] = []

  if (!present) {
    if (spec.required) {
      blocking.push({
        level: 'block',
        field: spec.key,
        message: `缺少必填字段 ${spec.key}`,
        hint: `${spec.label} 不能为空`
      })
    }
    return { blocking, warnings }
  }

  switch (spec.kind) {
    case 'string': {
      if (!isNonEmptyString(raw)) {
        blocking.push({ level: 'block', field: spec.key, message: `${spec.key} 必须是非空字符串` })
      }
      return { blocking, warnings }
    }
    case 'date': {
      const value = String(normalizeValue(raw)).slice(0, 10)
      if (!DATE_RE.test(value)) {
        blocking.push({
          level: 'block',
          field: spec.key,
          message: `${spec.key} 日期格式非法：${String(raw)}`,
          hint: '必须是 YYYY-MM-DD'
        })
        return { blocking, warnings }
      }
      return { blocking, warnings, normalized: value }
    }
    case 'enum': {
      if (!spec.options?.includes(String(raw))) {
        blocking.push({
          level: 'block',
          field: spec.key,
          message: `${spec.key} 取值越界：${String(raw)}`,
          hint: `允许值：${spec.options?.join(' / ')}`
        })
      }
      return { blocking, warnings }
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') {
        blocking.push({ level: 'block', field: spec.key, message: `${spec.key} 必须是布尔值` })
      }
      return { blocking, warnings }
    }
    case 'number': {
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(num)) {
        blocking.push({ level: 'block', field: spec.key, message: `${spec.key} 必须是数字` })
        return { blocking, warnings }
      }
      const min = spec.min ?? Number.NEGATIVE_INFINITY
      const max = spec.max ?? Number.POSITIVE_INFINITY
      if (num < min || num > max) {
        if (spec.clamp) {
          const value = Math.min(Math.max(num, min), max)
          warnings.push({
            level: 'warn',
            field: spec.key,
            message: `${spec.key} 越界（${num}），已自动夹取到 ${value}`,
            hint: `合法范围 ${min}–${max}`
          })
          return { blocking, warnings, normalized: value }
        }
        blocking.push({ level: 'block', field: spec.key, message: `${spec.key} 越界：${num}` })
      }
      return { blocking, warnings }
    }
    case 'stringArray': {
      if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) {
        blocking.push({ level: 'block', field: spec.key, message: `${spec.key} 必须是字符串数组` })
      }
      return { blocking, warnings }
    }
    case 'milestones': {
      const ok =
        Array.isArray(raw) &&
        raw.every(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            typeof (item as { title?: unknown }).title === 'string' &&
            typeof (item as { done?: unknown }).done === 'boolean'
        )
      if (!ok) {
        blocking.push({
          level: 'block',
          field: spec.key,
          message: `${spec.key} 必须是 { title, done } 数组`
        })
      }
      return { blocking, warnings }
    }
    default:
      return { blocking, warnings }
  }
}

/** 校验一份完整的 frontmatter 数据（读取/保存/发布前都可用） */
export function validateFrontmatter(
  section: ContentSection,
  data: Record<string, unknown>,
  options: { knownBlogSlugs?: string[]; publicDirExists?: (relPath: string) => boolean } = {}
): ValidationResult {
  const schema = schemaOf(section)
  const blocking: Issue[] = []
  const warnings: Issue[] = []
  const normalized: Record<string, unknown> = {}

  for (const spec of schema.fields) {
    const result = validateField(spec, data[spec.key])
    blocking.push(...result.blocking)
    warnings.push(...result.warnings)
    if (result.normalized !== undefined) normalized[spec.key] = result.normalized
  }

  // 分区特有规则
  const cover = data.cover
  if (section === 'blog' && isNonEmptyString(cover)) {
    if (!COVER_RE.test(cover)) {
      warnings.push({
        level: 'warn',
        field: 'cover',
        message: `封面路径不符合约定：${cover}`,
        hint: '应以 / 开头且以 .svg 结尾'
      })
    } else if (options.publicDirExists && !options.publicDirExists(cover)) {
      warnings.push({
        level: 'warn',
        field: 'cover',
        message: `封面文件不存在：${cover}`,
        hint: '封面尺寸优化会失效，页面仍可构建'
      })
    }
  }

  const article = data.article
  if (section === 'projects' && isNonEmptyString(article) && options.knownBlogSlugs) {
    if (!options.knownBlogSlugs.includes(article)) {
      warnings.push({
        level: 'warn',
        field: 'article',
        message: `article 指向不存在的 blog slug：${article}`,
        hint: '站点不校验，但项目页的关联链接会失效'
      })
    }
  }

  return { blocking, warnings, ok: blocking.length === 0, normalized }
}

/** 校验待写入的 patch（保存路径上先于落盘执行，只针对本次涉及的字段） */
export function validatePatch(section: ContentSection, patch: Record<string, unknown>): ValidationResult {
  const blocking: Issue[] = []
  const warnings: Issue[] = []

  for (const [key, value] of Object.entries(patch)) {
    const spec = fieldSpec(section, key)
    if (!spec) {
      // 未知字段不阻断（内容里可能存在站点未声明的扩展字段），但要提示
      warnings.push({ level: 'warn', field: key, message: `schema 未声明的字段：${key}` })
      continue
    }
    if (value === null || value === undefined) {
      if (spec.required) {
        blocking.push({
          level: 'block',
          field: key,
          message: `必填字段不能清空：${key}`,
          hint: `${spec.label} 是站点构建必需的`
        })
      }
      continue
    }
    const result = validateField(spec, value)
    blocking.push(...result.blocking)
    warnings.push(...result.warnings)
  }

  return { blocking, warnings, ok: blocking.length === 0, normalized: {} }
}

/** 删除保护：blog / diary / projects 使用 generateStaticParams，不允许删空 */
export function assertDeletable(section: ContentSection, remainingCount: number): void {
  const schema = schemaOf(section)
  if (remainingCount < schema.minCount) {
    throw new CmsError(
      'LAST_ITEM_PROTECTED',
      `content/${section}/ 至少保留 ${schema.minCount} 篇`,
      schema.minCount > 0
        ? 'Next 16 的 generateStaticParams 不接受空数组，删空会导致生产构建失败'
        : undefined
    )
  }
}