import { parseEntry, type ValidationIssue } from '@loxander/content-core'
import { CmsError } from '../errors'
import { normalizeValue } from './frontmatterService'
import { fieldSpec, schemaOf, type ContentSection, type FieldSpec } from './schemaService'

/**
 * 校验层（P1）：对齐基线 §6 的校验规则表。
 * - block：站点构建会失败 / 破坏构建，必须阻断保存或发布；
 * - warn：站点能跑但会静默降级（如封面尺寸优化失效），提示即可。
 *
 * **整表契约不再由本文件定义**：`validateFrontmatter` 直接委托给 `@loxander/content-core`
 * 的 `parseEntry`，与站点 `apps/web` 用同一份 Zod schema、同一套引用完整性规则。
 * 这样「契约」全仓库只有一份权威实现，desktop 不再可能出现「CMS 放行但站点构建失败」。
 *
 * 本文件保留的是**表单层的部分字段校验**（`validateField` / `validatePatch`）：
 * patch 只带本次改动的字段，拿不出一份完整文档，因此无法走 `parseEntry`。
 * 它是保存前的快速反馈，真正的裁决仍在 `validateFrontmatter`。
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
  /** 归一后的值（如 Date → YYYY-MM-DD） */
  normalized?: unknown
}

export interface ValidationResult {
  blocking: Issue[]
  warnings: Issue[]
  ok: boolean
  normalized: Record<string, unknown>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 该值是否算「有效存在」（空串/空值视为缺失） */
export function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string' && value.trim() === '') return false
  return true
}

/**
 * 把 content-core 的 issue 转成 CMS 的 Issue。
 *
 * content-core 的 message 是字段内语义（如「不能为空」），这里补上字段名前缀，
 * 让渲染层的错误列表能直接读懂；`hint` 原样带过来（content-core 目前只在 warning 上给）。
 */
function toIssues(issues: ValidationIssue[]): Issue[] {
  return issues.map((issue) => ({
    level: issue.level === 'block' ? 'block' : 'warn',
    field: issue.field,
    message: issue.field ? `${issue.field}: ${issue.message}` : issue.message,
    hint: issue.hint
  }))
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
        // 越界一律阻断，不再自动夹取：与 content-core 的 zProgress 保持一致，
        // 否则表单里会看到「显示 100 但文件里是 130」这种说谎的界面。
        blocking.push({
          level: 'block',
          field: spec.key,
          message: `${spec.key} 越界：${num}`,
          hint: `合法范围 ${spec.min ?? '−∞'}–${spec.max ?? '+∞'}`
        })
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

/**
 * 校验一份完整的 frontmatter 数据（读取/保存/发布前都可用）。
 *
 * 整表契约委托给 `@loxander/content-core` 的 `parseEntry`：四个分区的必填、
 * 日期格式、枚举取值、tags 归一、progress 范围、milestones 结构、order 兜底，
 * 以及 cover/article 的引用完整性，全部由共享包裁决。
 * 本函数只负责把结果翻译成 CMS 的 Issue 形态，并额外补一条 CMS 专有的
 * 「frontmatter 解析失败」由调用方处理（这里拿不到 dataError）。
 */
export function validateFrontmatter(
  section: ContentSection,
  data: Record<string, unknown>,
  options: { knownBlogSlugs?: string[]; publicDirExists?: (relPath: string) => boolean } = {}
): ValidationResult {
  const result = parseEntry(section, data, {
    knownBlogSlugs: options.knownBlogSlugs,
    // content-core 的 publicFileExists 收到的是站点绝对路径（以 / 开头），
    // 与 desktop 旧 publicDirExists 的契约一致，直接透传。
    publicFileExists: options.publicDirExists
  })

  const blocking = toIssues(result.blocking)
  const warnings = toIssues(result.warnings)
  const normalized: Record<string, unknown> = result.data
    ? (result.data as unknown as Record<string, unknown>)
    : {}

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
