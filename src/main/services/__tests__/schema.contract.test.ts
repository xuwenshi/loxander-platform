import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocument } from '../frontmatterService'
import { CONTENT_SECTIONS, schemaOf, type ContentSection } from '../schemaService'
import { assertDeletable, validateFrontmatter } from '../validateService'
import { CONTENT_ROOT, listContentFiles } from './fixtures'

/**
 * P1 门禁之一：**契约测试全绿**。
 * 用真实内容锁死 schema 漂移：11 篇必须全部通过 CMS 校验，且引用完整性无告警。
 */

const files = listContentFiles()
const blogSlugs = files.filter((item) => item.section === 'blog').map((item) => item.slug)

function validate(item: { section: ContentSection; text: string }) {
  const doc = parseDocument(item.text)
  return {
    doc,
    result: validateFrontmatter(item.section, doc.data, {
      knownBlogSlugs: item.section === 'projects' ? blogSlugs : undefined,
      publicDirExists: (relPath) => existsSync(join(CONTENT_ROOT, '..', 'public', relPath.replace(/^\//, '')))
    })
  }
}

describe('frontmatter 契约（真实内容）', () => {
  it('四分区数量符合预期', () => {
    const counts = Object.fromEntries(
      CONTENT_SECTIONS.map((section) => [section, files.filter((item) => item.section === section).length])
    )
    expect(counts).toEqual({ blog: 4, diary: 2, projects: 3, goals: 2 })
  })

  it('11 篇全部解析成功且无阻断问题', () => {
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

    const clamped = validateFrontmatter('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: 130
    })
    expect(clamped.ok).toBe(true)
    expect(clamped.normalized.progress).toBe(100)
    expect(clamped.warnings[0]?.field).toBe('progress')
  })

  it('删除保护：blog/diary/projects 不允许删空，goals 允许', () => {
    expect(() => assertDeletable('diary', 0)).toThrowError(/至少保留 1 篇/)
    expect(() => assertDeletable('blog', 0)).toThrowError()
    expect(() => assertDeletable('projects', 0)).toThrowError()
    expect(() => assertDeletable('diary', 1)).not.toThrow()
    expect(() => assertDeletable('goals', 0)).not.toThrow()
  })
})