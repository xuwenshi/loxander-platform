import { describe, expect, it } from 'vitest'
import { dedupeSortedPaths, normalizeContentPath } from '../contentWatcherService'

/**
 * 外部改动感知的门禁：只测不依赖真实 fs.watch 时序的纯函数
 * （路径归一 / 过滤 / 去重），避免测试因文件系统事件抖动而不稳定。
 */

describe('normalizeContentPath：路径归一与过滤', () => {
  it('把 content 下的 .md 归一成 workspace 相对 POSIX 路径', () => {
    expect(normalizeContentPath('blog/demo.md')).toBe('content/blog/demo.md')
    // Windows 上 fs.watch 回调给的是反斜杠
    expect(normalizeContentPath('blog\\demo.md')).toBe('content/blog/demo.md')
  })

  it('已是 content/ 前缀时不重复拼接（监听根目录的兜底情形）', () => {
    expect(normalizeContentPath('content/blog/demo.md')).toBe('content/blog/demo.md')
    expect(normalizeContentPath('./blog/demo.md')).toBe('content/blog/demo.md')
  })

  it('过滤掉非 .md 与无法归因的事件', () => {
    expect(normalizeContentPath(null)).toBeNull()
    expect(normalizeContentPath(undefined)).toBeNull()
    expect(normalizeContentPath('')).toBeNull()
    expect(normalizeContentPath('blog')).toBeNull()
    expect(normalizeContentPath('public/cover.svg')).toBeNull()
  })

  it('过滤编辑器临时文件与隐藏文件', () => {
    expect(normalizeContentPath('.demo.md.swp')).toBeNull()
    expect(normalizeContentPath('blog/.demo.md.swp')).toBeNull()
    expect(normalizeContentPath('blog/4913')).toBeNull()
    expect(normalizeContentPath('blog/demo.md.tmp')).toBeNull()
    expect(normalizeContentPath('blog/.hidden.md')).toBeNull()
    expect(normalizeContentPath('.git/blog.md')).toBeNull()
  })

  it('大小写不敏感地识别 .md 扩展名', () => {
    expect(normalizeContentPath('blog/Demo.MD')).toBe('content/blog/Demo.MD')
  })
})

describe('dedupeSortedPaths：同批事件去重且排序稳定', () => {
  it('去重并升序排列', () => {
    expect(dedupeSortedPaths(['content/b.md', 'content/a.md', 'content/b.md'])).toEqual([
      'content/a.md',
      'content/b.md'
    ])
  })

  it('空集合返回空数组', () => {
    expect(dedupeSortedPaths([])).toEqual([])
  })
})