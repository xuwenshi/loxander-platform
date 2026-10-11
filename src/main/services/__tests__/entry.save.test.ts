import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readEntry, saveEntry } from '../entryService'

/**
 * P1 门禁之二：**冲突能被拦截**，且保存链路（备份 → 原子写 → 校验）闭环可用。
 * 用临时目录构造一个小仓库，不触碰真实 my-blog。
 */

const ROOT = mkdtempSync(join(tmpdir(), 'cms-entry-'))
const BACKUP = join(ROOT, '.cms-backups')
const BLOG_DIR = join(ROOT, 'content', 'blog')

const SAMPLE = [
  '---',
  'title: "原标题"',
  'description: "描述文本"',
  'date: 2026-09-24',
  'category: "工程实践"',
  'tags: ["Next.js", "前端"]',
  '---',
  '',
  '正文第一段。',
  ''
].join('\n')

const FILE = join(BLOG_DIR, 'demo.md')

beforeEach(() => {
  mkdirSync(BLOG_DIR, { recursive: true })
  writeFileSync(FILE, SAMPLE, 'utf8')
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

function save(patch: Record<string, unknown>, expected: ReturnType<typeof readEntry>['fingerprint'], extra: Record<string, unknown> = {}) {
  return saveEntry({
    workspaceRoot: ROOT,
    backupRoot: BACKUP,
    section: 'blog',
    slug: 'demo',
    patch,
    expected,
    ...extra
  })
}

describe('保存链路与乐观锁', () => {
  it('字段级保存：只改目标行 + 生成备份', () => {
    const entry = readEntry(ROOT, 'blog', 'demo')
    const result = save({ title: '新标题' }, entry.fingerprint)

    expect(result.changed).toBe(true)
    expect(result.changes.map((change) => change.key)).toEqual(['title'])
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true)

    const lines = readFileSync(FILE, 'utf8').split('\n')
    expect(lines[1]).toBe('title: "新标题"')
    expect(lines[2]).toBe('description: "描述文本"')
    expect(lines[5]).toBe('tags: ["Next.js", "前端"]')
  })

  it('保存后再次以相同值保存 → 无变更', () => {
    const first = readEntry(ROOT, 'blog', 'demo')
    save({ title: '新标题' }, first.fingerprint)

    const second = readEntry(ROOT, 'blog', 'demo')
    const result = save({ title: '新标题' }, second.fingerprint)
    expect(result.changed).toBe(false)
    expect(result.diff.filter((line) => line.type !== 'equal')).toEqual([])
  })

  it('正文保存不动 frontmatter 字节', () => {
    const entry = readEntry(ROOT, 'blog', 'demo')
    const before = entry.text.slice(0, entry.text.indexOf('\n---\n'))
    const result = saveEntry({
      workspaceRoot: ROOT,
      backupRoot: BACKUP,
      section: 'blog',
      slug: 'demo',
      body: '\n改过的正文。\n',
      expected: entry.fingerprint
    })
    expect(result.changed).toBe(true)
    const after = readFileSync(FILE, 'utf8')
    expect(after.slice(0, after.indexOf('\n---\n'))).toBe(before)
    expect(after).toContain('改过的正文。')
  })

  it('外部改动后保存被拦截（CONFLICT）', () => {
    const entry = readEntry(ROOT, 'blog', 'demo')
    writeFileSync(FILE, entry.text.replace('原标题', '别人改的标题'), 'utf8')

    let code = ''
    try {
      save({ title: '我的标题' }, entry.fingerprint)
    } catch (err) {
      code = (err as { code?: string }).code ?? ''
    }
    expect(code).toBe('CONFLICT')
    // 磁盘内容未被覆盖
    expect(readFileSync(FILE, 'utf8')).toContain('别人改的标题')
  })

  it('人工确认后允许强制覆盖', () => {
    const entry = readEntry(ROOT, 'blog', 'demo')
    writeFileSync(FILE, entry.text.replace('原标题', '别人改的标题'), 'utf8')
    const result = save({ title: '我的标题' }, entry.fingerprint, { force: true })
    expect(result.changed).toBe(true)
    expect(readFileSync(FILE, 'utf8')).toContain('我的标题')
  })

  it('必填字段被清空时保存被拦下（VALIDATION_FAILED）', () => {
    const entry = readEntry(ROOT, 'blog', 'demo')
    let code = ''
    try {
      save({ title: '' }, entry.fingerprint)
    } catch (err) {
      code = (err as { code?: string }).code ?? ''
    }
    expect(code).toBe('VALIDATION_FAILED')
    expect(readFileSync(FILE, 'utf8')).toBe(SAMPLE)
  })
})