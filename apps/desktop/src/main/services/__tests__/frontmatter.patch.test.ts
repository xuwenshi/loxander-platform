import { describe, expect, it } from 'vitest'
import { parseDocument } from '../frontmatterService'
import { patchFrontmatter, planPatch } from '../contentPatchService'

/**
 * P1 门禁之一：**保存仅改动目标字段，其余字节与正文逐字节不变。**
 */

const SAMPLE = [
  '---',
  'title: "原标题"',
  'description: "描述文本"',
  'date: 2026-09-24',
  'category: "工程实践"',
  'tags: ["Next.js", "前端"]',
  'cover: "/images/rag-pipeline.svg"',
  '---',
  '',
  '正文第一段。',
  '',
  '## 小节',
  '',
  '正文结尾。',
  ''
].join('\n')

function linesOf(text: string): string[] {
  return text.split('\n')
}

describe('字段级 patch：只改被编辑字段', () => {
  it('改 title 时其余行逐字节不变', () => {
    const doc = parseDocument(SAMPLE)
    const outcome = patchFrontmatter(doc, { title: '新标题' })
    expect(outcome.changed).toBe(true)

    const before = linesOf(SAMPLE)
    const after = linesOf(outcome.text)
    expect(after.length).toBe(before.length)

    const diffIndexes = before.map((line, i) => (line === after[i] ? -1 : i)).filter((i) => i >= 0)
    expect(diffIndexes).toEqual([1]) // 只有 title 那一行变了
    expect(after[1]).toBe('title: "新标题"')
  })

  it('正文完全不被触碰', () => {
    const doc = parseDocument(SAMPLE)
    const outcome = patchFrontmatter(doc, { description: '改过的描述' })
    expect(outcome.text.endsWith(doc.body)).toBe(true)
    expect(outcome.text.slice(outcome.text.indexOf('\n---\n'))).toBe(SAMPLE.slice(SAMPLE.indexOf('\n---\n')))
  })

  it('日期保持裸值书写形态（不变成 Date/ISO）', () => {
    const doc = parseDocument(SAMPLE)
    const outcome = patchFrontmatter(doc, { date: '2026-10-11' })
    expect(outcome.text).toContain('\ndate: 2026-10-11\n')
    expect(outcome.text).not.toContain('T00:00')
  })

  it('数组字段维持行内流式风格', () => {
    const doc = parseDocument(SAMPLE)
    const outcome = patchFrontmatter(doc, { tags: ['RAG', 'LLM'] })
    expect(outcome.text).toContain('tags: ["RAG", "LLM"]')
  })

  it('新增字段：追加到末尾，不动既有字段', () => {
    const doc = parseDocument(SAMPLE)
    const outcome = patchFrontmatter(doc, { draft: false })
    const changed = outcome.changes.find((change) => change.key === 'draft')
    expect(changed?.kind).toBe('add')
    expect(outcome.text).toContain('\ndraft: false\n---\n')
    // 既有字段原样保留
    for (const line of ['title: "原标题"', 'description: "描述文本"', 'date: 2026-09-24']) {
      expect(outcome.text).toContain(line)
    }
  })

  it('删除可选字段：值为 null 时移除该行', () => {
    const doc = parseDocument(SAMPLE)
    const outcome = patchFrontmatter(doc, { cover: null })
    expect(outcome.text).not.toContain('cover:')
    expect(outcome.text).toContain('tags: ["Next.js", "前端"]')
  })

  it('块状 milestones 保持块状书写', () => {
    const text = ['---', 'title: "目标"', 'horizon: "long"', 'milestones:', '  - title: "A"', '    done: false', '---', ''].join('\n')
    const doc = parseDocument(text)
    const outcome = patchFrontmatter(doc, {
      milestones: [
        { title: 'A', done: true },
        { title: 'B', done: false }
      ]
    })
    expect(outcome.text).toContain(
      ['milestones:', '  - title: "A"', '    done: true', '  - title: "B"', '    done: false'].join('\n')
    )
    expect(outcome.text).toContain('title: "目标"')
  })

  it('语义未变的 patch 被跳过（不制造格式化噪声）', () => {
    const doc = parseDocument(SAMPLE)
    const planned = planPatch(doc, {
      title: '原标题',
      date: '2026-09-24',
      tags: ['Next.js', '前端']
    })
    expect(planned.changed).toBe(false)
    expect(planned.text).toBe(SAMPLE)
    expect(planned.skipped.sort()).toEqual(['date', 'tags', 'title'])
  })

  it('CRLF 文件保持 CRLF', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n')
    const doc = parseDocument(crlf)
    const outcome = patchFrontmatter(doc, { title: '新标题' })
    expect(outcome.text).toContain('title: "新标题"\r\n')
    expect(outcome.text.includes('\n---\r\n')).toBe(true)
    expect((outcome.text.match(/\r\n/g) ?? []).length).toBe((crlf.match(/\r\n/g) ?? []).length)
  })
})