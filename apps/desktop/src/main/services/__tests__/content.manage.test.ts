import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEntry, deleteEntry, listCovers, readEntry, renameEntry } from '../entryService'
import { validateFrontmatter } from '../validateService'

/**
 * P3 门禁：内容管理闭环（新建 / 删除 / 重命名 / 封面枚举）。
 * 全部在临时仓库上进行，绝不触碰真实 my-blog。
 */

let ROOT = ''
const BACKUP = () => join(ROOT, '.cms-backups')

function seed(section: string, slug: string, text: string): void {
  const dir = join(ROOT, 'content', section)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}.md`), text, 'utf8')
}

const BLOG_ONE = ['---', 'title: "旧标题"', 'description: "描述"', 'date: 2026-09-24', '---', '', '正文。', ''].join('\n')

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return (err as { code?: string }).code ?? ''
  }
  return ''
}

beforeEach(() => {
  ROOT = join(tmpdir(), `cms-manage-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(ROOT, { recursive: true })
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('新建条目', () => {
  it('为 blog 生成自洽合法的初始文件（必填字段齐备、日期裸写）', () => {
    const result = createEntry({ workspaceRoot: ROOT, section: 'blog', slug: 'new-post' })
    expect(existsSync(result.file)).toBe(true)

    const text = readFileSync(result.file, 'utf8')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('title: "new-post"')
    expect(text).toContain('date: ')

    // 新建出来的文件必须能通过契约校验，且能被正常读回
    const entry = readEntry(ROOT, 'blog', 'new-post')
    expect(entry.dataError).toBeNull()
    expect(validateFrontmatter('blog', entry.data).ok).toBe(true)
  })

  it('标题/日期可覆盖默认值', () => {
    const result = createEntry({
      workspaceRoot: ROOT,
      section: 'blog',
      slug: 'with-title',
      title: '自定义标题',
      date: '2026-01-02'
    })
    const text = readFileSync(result.file, 'utf8')
    expect(text).toContain('title: "自定义标题"')
    expect(text).toContain('date: 2026-01-02')
  })

  it('目标已存在 → ENTRY_EXISTS（不覆盖）', () => {
    seed('blog', 'dup', BLOG_ONE)
    expect(codeOf(() => createEntry({ workspaceRoot: ROOT, section: 'blog', slug: 'dup' }))).toBe('ENTRY_EXISTS')
    expect(readFileSync(join(ROOT, 'content', 'blog', 'dup.md'), 'utf8')).toBe(BLOG_ONE)
  })

  it('非法 slug → INVALID_SLUG（含路径穿越形态）', () => {
    expect(codeOf(() => createEntry({ workspaceRoot: ROOT, section: 'blog', slug: '../escape' }))).toBe('INVALID_SLUG')
    expect(codeOf(() => createEntry({ workspaceRoot: ROOT, section: 'blog', slug: 'a/b' }))).toBe('INVALID_SLUG')
  })
})

describe('删除条目', () => {
  it('删除生成备份并回收计数', () => {
    seed('blog', 'a', BLOG_ONE)
    seed('blog', 'b', BLOG_ONE)
    const result = deleteEntry(ROOT, BACKUP(), 'blog', 'a')
    expect(existsSync(result.file)).toBe(false)
    expect(result.remaining).toBe(1)
    expect(existsSync(result.backupPath)).toBe(true)
    expect(readFileSync(result.backupPath, 'utf8')).toBe(BLOG_ONE)
  })

  it('删空受保护分区 → LAST_ITEM_PROTECTED（文件保留）', () => {
    seed('blog', 'only', BLOG_ONE)
    expect(codeOf(() => deleteEntry(ROOT, BACKUP(), 'blog', 'only'))).toBe('LAST_ITEM_PROTECTED')
    expect(existsSync(join(ROOT, 'content', 'blog', 'only.md'))).toBe(true)
  })

  it('goals 允许删空（minCount = 0）', () => {
    seed('goals', 'g1', ['---', 'title: "目标"', 'horizon: "short"', 'status: "planned"', '---', ''].join('\n'))
    const result = deleteEntry(ROOT, BACKUP(), 'goals', 'g1')
    expect(result.remaining).toBe(0)
    expect(existsSync(result.file)).toBe(false)
  })

  it('目标不存在 → ENTRY_NOT_FOUND', () => {
    expect(codeOf(() => deleteEntry(ROOT, BACKUP(), 'blog', 'ghost'))).toBe('ENTRY_NOT_FOUND')
  })
})

describe('重命名条目', () => {
  it('保留逐字节内容，并提示旧 URL 将 404', () => {
    seed('blog', 'old-slug', BLOG_ONE)
    const result = renameEntry(ROOT, 'blog', 'old-slug', 'new-slug')

    expect(existsSync(result.previousFile)).toBe(false)
    expect(existsSync(result.file)).toBe(true)
    expect(readFileSync(result.file, 'utf8')).toBe(BLOG_ONE)
    expect(result.staleUrl).toBe('/blog/old-slug')
  })

  it('blog 重命名会报出 projects.article 的级联引用（只提示、不改写）', () => {
    seed('blog', 'target', BLOG_ONE)
    const project = [
      '---',
      'name: "项目"',
      'description: "描述"',
      'status: "active"',
      'article: "target"',
      'order: 1',
      '---',
      ''
    ].join('\n')
    seed('projects', 'linked', project)

    const result = renameEntry(ROOT, 'blog', 'target', 'renamed')
    expect(result.references).toHaveLength(1)
    expect(result.references[0].field).toBe('article')
    expect(result.references[0].slug).toBe('linked')
    // 引用未被自动改写
    expect(readFileSync(join(ROOT, 'content', 'projects', 'linked.md'), 'utf8')).toBe(project)
  })

  it('非 blog 分区不扫描 article 引用', () => {
    seed('projects', 'p1', ['---', 'name: "项目"', 'description: "描述"', 'status: "active"', '---', ''].join('\n'))
    const result = renameEntry(ROOT, 'projects', 'p1', 'p2')
    expect(result.references).toEqual([])
    expect(result.staleUrl).toBeNull()
  })

  it('目标已存在 → ENTRY_EXISTS；同名 → INVALID_SLUG', () => {
    seed('blog', 'a', BLOG_ONE)
    seed('blog', 'b', BLOG_ONE)
    expect(codeOf(() => renameEntry(ROOT, 'blog', 'a', 'b'))).toBe('ENTRY_EXISTS')
    expect(codeOf(() => renameEntry(ROOT, 'blog', 'a', 'a'))).toBe('INVALID_SLUG')
  })
})

describe('封面枚举', () => {
  it('递归列出 public 下的 .svg 并忽略其它文件', () => {
    mkdirSync(join(ROOT, 'public', 'images'), { recursive: true })
    writeFileSync(join(ROOT, 'public', 'cover.svg'), '<svg/>', 'utf8')
    writeFileSync(join(ROOT, 'public', 'images', 'deep.svg'), '<svg/>', 'utf8')
    writeFileSync(join(ROOT, 'public', 'readme.txt'), 'x', 'utf8')

    expect(listCovers(ROOT).map((item) => item.path)).toEqual(['/cover.svg', '/images/deep.svg'])
  })

  it('public 不存在时返回空数组（不抛错）', () => {
    expect(listCovers(ROOT)).toEqual([])
  })
})