import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocument } from '../frontmatterService'
import { CONTENT_SECTIONS, schemaOf, type ContentSection } from '../schemaService'
import { assertDeletable, validateFrontmatter } from '../validateService'
import { PUBLIC_ROOT, listContentFiles } from './fixtures'

/**
 * P1 门禁之一：**契约测试全绿**。
 * 用真实内容锁死 schema 漂移：所有现存内容必须全部通过 CMS 校验，且引用完整性无告警。
 * 注意：不断言具体篇数——内容随时会增删，这正是 CMS 的用途；只断言结构性不变量。
 */

const files = listContentFiles()
const blogSlugs = files.filter((item) => item.section === 'blog').map((item) => item.slug)

function validate(item: { section: ContentSection; text: string }) {
  const doc = parseDocument(item.text)
  return {
    doc,
    result: validateFrontmatter(item.section, doc.data, {
      knownBlogSlugs: item.section === 'projects' ? blogSlugs : undefined,
      publicDirExists: (relPath) => existsSync(join(PUBLIC_ROOT, relPath.replace(/^\//, '')))
    })
  }
}

describe('frontmatter 契约（真实内容）', () => {
  it('四分区均可枚举，且满足 Next 路由的删空约束', () => {
    const counts: Record<string, number> = Object.fromEntries(
      CONTENT_SECTIONS.map((section) => [section, files.filter((item) => item.section === section).length])
    )
    // 不锁定具体篇数：内容随时会增删，这正是 CMS 的用途；这里只锁结构性不变量。
    expect(Object.keys(counts).sort()).toEqual([...CONTENT_SECTIONS].sort())
    for (const section of ['blog', 'diary', 'projects'] as const) {
      // 这三个分区走 generateStaticParams（不接受空数组），必须各有 ≥1 篇
      expect(counts[section], `${section} 不允许为空`).toBeGreaterThanOrEqual(1)
    }
    // goals 无 [slug] 路由，允许为空
    expect(counts.goals).toBeGreaterThanOrEqual(0)
  })

  it('全部真实内容解析成功且无阻断问题', () => {
    for (const item of files) {
      const { doc, result } = validate(item)
      expect(doc.hasFrontmatter, `${item.section}/${item.slug}`).toBe(true)
      expect(doc.dataError, `${item.section}/${item.slug}`).toBeNull()
      expect(result.blocking, `${item.section}/${item.slug}`).toEqual([])
      expect(result.ok, `${item.section}/${item.slug}`).toBe(true)
    }
  })

  it('无引用完整性告警（cover 存在、projects.article 指向有效 slug）', () => {
    for (const item of files) {
      const { result } = validate(item)
      expect(result.warnings, `${item.section}/${item.slug}`).toEqual([])
    }
  })

  it('必填字段确实齐全（逐分区抽查）', () => {
    for (const item of files) {
      const { doc } = validate(item)
      for (const spec of schemaOf(item.section).fields) {
        if (!spec.required) continue
        expect(doc.data[spec.key], `${item.section}/${item.slug} 缺 ${spec.key}`).toBeDefined()
      }
    }
  })

  it('校验器能真正拦住坏数据（负向用例）', () => {
    const missing = validateFrontmatter('blog', { description: '有描述', date: '2026-01-01' })
    expect(missing.ok).toBe(false)
    expect(missing.blocking.map((issue) => issue.field)).toContain('title')

    const badDate = validateFrontmatter('blog', { title: 't', description: 'd', date: '2026/01/01' })
    expect(badDate.ok).toBe(false)

    const badEnum = validateFrontmatter('projects', { name: 'n', description: 'd', status: 'unknown' })
    expect(badEnum.ok).toBe(false)

    // progress 越界：P1 接上 @loxander/content-core 后从「静默夹取到 100 + warning」
    // 改成了「阻断」。这是有意的收紧 —— 夹取会让表单显示 100 而文件里还是 130。
    const outOfRange = validateFrontmatter('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: 130
    })
    expect(outOfRange.ok).toBe(false)
    expect(outOfRange.blocking.map((issue) => issue.field)).toContain('progress')

    // 小数仍然按四舍五入归一（不阻断），这是保留的宽松行为。
    const rounded = validateFrontmatter('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: 50.6
    })
    expect(rounded.ok).toBe(true)
    expect(rounded.normalized.progress).toBe(51)
  })

  it('删除保护：blog/diary/projects 不允许删空，goals 允许', () => {
    expect(() => assertDeletable('diary', 0)).toThrowError(/至少保留 1 篇/)
    expect(() => assertDeletable('blog', 0)).toThrowError()
    expect(() => assertDeletable('projects', 0)).toThrowError()
    expect(() => assertDeletable('diary', 1)).not.toThrow()
    expect(() => assertDeletable('goals', 0)).not.toThrow()
  })
})