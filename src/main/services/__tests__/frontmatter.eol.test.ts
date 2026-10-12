import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readEntry, saveEntry } from '../entryService'
import { assembleDocument, parseDocument } from '../frontmatterService'

/**
 * 换行符不变量：my-blog 的 `content/**\/*.md` 在 Windows 检出后是 **CRLF**，
 * 而编辑器缓冲区（CodeMirror 内部模型）一律是 **LF**。
 * 若写回时不还原原文件的换行符，一次「内容其实没变」的保存就会把整篇正文翻成 LF，
 * 在 Git 上表现为全文件 diff（语义没变但 diff 巨大），且文件变成「frontmatter CRLF + 正文 LF」的混合换行符。
 */

const ROOT = mkdtempSync(join(tmpdir(), 'cms-eol-'))
const BACKUP = join(ROOT, '.cms-backups')
const BLOG_DIR = join(ROOT, 'content', 'blog')
const FILE = join(BLOG_DIR, 'demo.md')

const CRLF = [
  '---',
  'title: "原标题"',
  'description: "描述文本"',
  'date: 2026-09-24',
  '---',
  '',
  '正文第一段。',
  ''
].join('\r\n')

/** 模拟编辑器缓冲区：一律 LF */
const toLf = (text: string): string => text.replace(/\r\n?/g, '\n')

beforeEach(() => {
  mkdirSync(BLOG_DIR, { recursive: true })
  writeFileSync(FILE, CRLF, 'utf8')
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('assembleDocument 保留原文件换行符', () => {
  it('CRLF 文件 + LF 正文 → 拼回仍是 CRLF', () => {
    const doc = parseDocument(CRLF)
    // body 从闭合分隔行之后开始，所以包含紧随其后那个空行的换行符
    expect(doc.body).toBe('\r\n正文第一段。\r\n')
    const out = assembleDocument(doc, doc.frontmatterRaw, toLf(doc.body))
    expect(out).toBe(CRLF)
  })

  it('LF 文件 + CRLF 正文 → 归一为 LF（不会写出 \\r\\r\\n）', () => {
    const lf = toLf(CRLF)
    const doc = parseDocument(lf)
    const out = assembleDocument(doc, doc.frontmatterRaw, doc.body.replace(/\n/g, '\r\n'))
    expect(out).toBe(lf)
  })
})

describe('CRLF 内容保存时无换行符噪声', () => {
  it('正文只做了 LF 归一（语义未变）→ 不写盘，磁盘逐字节不变', () => {
    const before = readEntry(ROOT, 'blog', 'demo')
    const result = saveEntry({
      workspaceRoot: ROOT,
      backupRoot: BACKUP,
      section: 'blog',
      slug: 'demo',
      patch: {},
      body: toLf(before.body),
      expected: before.fingerprint,
      force: false
    })
    expect(result.changed).toBe(false)
    expect(readFileSync(FILE, 'utf8')).toBe(CRLF)
  })

  it('正文确有改动 → 只在改动处变化，换行符仍是 CRLF', () => {
    const before = readEntry(ROOT, 'blog', 'demo')
    const result = saveEntry({
      workspaceRoot: ROOT,
      backupRoot: BACKUP,
      section: 'blog',
      slug: 'demo',
      patch: {},
      body: `${toLf(before.body)}新增一行。\n`,
      expected: before.fingerprint,
      force: false
    })
    expect(result.changed).toBe(true)

    const written = readFileSync(FILE, 'utf8')
    expect(written).toBe(`${CRLF}新增一行。\r\n`)
    // 全文只有 CRLF，不得混入孤立 LF
    expect(written.replace(/\r\n/g, '').includes('\n')).toBe(false)
  })
})