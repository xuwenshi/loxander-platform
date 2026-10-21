import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

/**
 * 外部改动感知：监听博客仓库的 content/ 目录，把「在 CMS 之外」发生的
 * Markdown 新增 / 修改 / 删除聚合成一次事件推给 renderer。
 *
 * 设计要点：
 * - 只在 content/ 内、只关心 .md（隐藏文件与编辑器临时文件天然被过滤）；
 * - debounce 合并连写（编辑器保存往往触发多次事件），并对同批路径去重排序；
 * - 路径统一成 workspace 相对 + POSIX 分隔符（如 content/blog/demo.md），
 *   这样 renderer 无需处理 Windows 反斜杠与绝对路径；
 * - 不 import electron：工作区根与回调由调用方注入，纯函数部分可直接单测。
 */

/** 默认 debounce 窗口：足够覆盖一次保存的多条事件，又不至于让 UI 明显延迟 */
export const DEFAULT_DEBOUNCE_MS = 300

export interface ContentChangeEvent {
  /** 被监听的工作区根（renderer 据此丢弃过期工作区的事件） */
  workspaceRoot: string
  /** 变更文件的 workspace 相对路径（POSIX，已去重排序） */
  paths: string[]
  /** 触发时间（ISO 字符串，便于日志与调试） */
  at: string
}

export interface ContentWatcherHandle {
  close: () => void
}

/**
 * 把 fs.watch 回调里的 filename 归一成 workspace 相对路径；不合格的一律返回 null。
 * filename 是相对「被监听目录」的路径（可能是 `blog\demo.md`），也可能为 null（无法归因）。
 * 纯函数：不触碰 fs，便于单测。
 */
export function normalizeContentPath(filename: string | null | undefined): string | null {
  if (!filename) return null
  const rel = String(filename).replace(/\\/g, '/').replace(/^\.\//, '')
  if (!rel) return null
  // 只收 .md；编辑器临时文件（.swp / .tmp / 4913 等）不以此结尾，自然被排除
  if (!rel.toLowerCase().endsWith('.md')) return null
  // 排除隐藏文件（.foo.md）与任何一段以 . 开头的中间目录
  const segments = rel.split('/')
  if (segments.some((seg) => seg.startsWith('.'))) return null
  const base = segments[segments.length - 1]
  if (!base) return null
  // 若调用方监听的是仓库根（filename 已带 content/ 前缀），避免重复拼接
  const normalized = rel.startsWith('content/') ? rel : `content/${rel}`
  return normalized
}

/** 去重 + 排序（纯函数）：同一批事件里同一文件被写多次只留一份，顺序稳定便于断言 */
export function dedupeSortedPaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort()
}

function nameOf(filename: string | Buffer | null): string | null {
  if (filename === null || filename === undefined) return null
  return typeof filename === 'string' ? filename : filename.toString('utf8')
}

/**
 * 启动 content/ 目录监听。
 * 返回句柄，调用方在「工作区变更 / 应用退出」时必须 close()，避免句柄泄漏。
 */
export function createContentWatcher(options: {
  workspaceRoot: string
  debounceMs?: number
  onChanges: (event: ContentChangeEvent) => void
}): ContentWatcherHandle {
  const { workspaceRoot, onChanges } = options
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const contentDir = join(workspaceRoot, 'content')

  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let watcher: FSWatcher | null = null

  const flush = (): void => {
    timer = null
    if (closed || pending.size === 0) return
    const paths = dedupeSortedPaths(pending)
    pending.clear()
    try {
      onChanges({ workspaceRoot, paths, at: new Date().toISOString() })
    } catch (err) {
      // 回调异常不能拖垮 watcher 本身
      console.error('[cms] content watcher 回调失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const schedule = (filename: string | null): void => {
    const path = normalizeContentPath(filename)
    if (!path) return
    pending.add(path)
    // 每次新事件都重置计时器：等到「安静」了才一次性上报
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  }

  try {
    // Windows / macOS 原生支持 recursive；Linux 老版本 Node 会抛错，落进 catch 只记录不致命
    watcher = watch(contentDir, { recursive: true }, (_event, filename) => {
      schedule(nameOf(filename))
    })
    watcher.on('error', (err) => {
      console.error('[cms] content watcher 错误：' + err.message)
    })
  } catch (err) {
    console.error(
      `[cms] 无法监听 content 目录（${contentDir}）：` + (err instanceof Error ? err.message : String(err))
    )
  }

  return {
    close: () => {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
      watcher?.close()
      watcher = null
    }
  }
}