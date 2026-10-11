import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CmsError } from '../errors'

/**
 * 文件写入层（P1）：读取指纹 + 原子写 + 备份。
 * 不依赖 electron，便于用临时目录做单测。
 */

export interface FileFingerprint {
  mtimeMs: number
  size: number
  sha256: string
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new CmsError('ENTRY_NOT_FOUND', `文件不存在：${path}`, '可能已被重命名或删除，请刷新列表')
    }
    throw new CmsError('FS_ERROR', `读取文件失败：${path}`, err instanceof Error ? err.message : String(err))
  }
}

export function fingerprintOf(content: string, mtimeMs: number): FileFingerprint {
  return { mtimeMs, size: Buffer.byteLength(content, 'utf8'), sha256: sha256(content) }
}

export function readFingerprint(path: string): FileFingerprint {
  const content = readText(path)
  const stat = statSync(path)
  return fingerprintOf(content, stat.mtimeMs)
}

export function sameFingerprint(a: FileFingerprint | null, b: FileFingerprint | null): boolean {
  if (!a || !b) return false
  // 哈希是最终裁决；mtime/size 仅作快速短路
  return a.sha256 === b.sha256
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST'])
let tmpCounter = 0

function sleepSync(ms: number): void {
  // 不引入依赖的同步退避；Windows 上文件被短暂占用（杀软/索引）时重试
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* spin */
  }
}

/**
 * 原子写：同目录 temp 文件 → write + fsync → rename 覆盖。
 * Windows 上 rename 可能因占用报 EPERM/EBUSY，做有限次退避重试。
 */
export function atomicWriteText(path: string, text: string): void {
  const dir = dirname(path)
  const tmp = join(dir, `.${basename(path)}.cms-${process.pid}-${tmpCounter++}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(tmp, 'w')
    writeSync(fd, text, null, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw new CmsError('WRITE_FAILED', `写入临时文件失败：${tmp}`, err instanceof Error ? err.message : String(err))
  }

  let lastError: unknown = null
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      renameSync(tmp, path)
      return
    } catch (err) {
      lastError = err
      const code = (err as NodeJS.ErrnoException).code
      if (!RETRYABLE.has(code ?? '')) break
      sleepSync(25 * (attempt + 1))
    }
  }
  try {
    unlinkSync(tmp)
  } catch {
    /* ignore */
  }
  throw new CmsError(
    'WRITE_FAILED',
    `原子替换失败：${path}`,
    lastError instanceof Error ? lastError.message : String(lastError)
  )
}

/** 复制备份（保留原文件字节）；目标目录不存在时自动创建 */
export function backupFile(src: string, dest: string): void {
  try {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  } catch (err) {
    throw new CmsError('FS_ERROR', `创建备份失败：${dest}`, err instanceof Error ? err.message : String(err))
  }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}