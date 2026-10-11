import { CmsError } from '../errors'
import { readFingerprint, readText, sameFingerprint, type FileFingerprint } from './atomicFile'

/**
 * 冲突检测（乐观锁）。
 * 读取时记录 {mtime, size, sha256}，保存前比对；不一致说明文件在编辑期间被外部改动
 * （git pull、另一编辑器、脚本），此时**拒绝静默覆盖**，把两侧差异交给用户裁决。
 */

export interface ConflictDetail {
  expected: FileFingerprint
  actual: FileFingerprint
  /** 磁盘当前内容，供 UI 与缓冲版本做并排 diff */
  diskText: string
}

export function assertUnchanged(path: string, expected: FileFingerprint): void {
  const actual = readFingerprint(path)
  if (sameFingerprint(expected, actual)) return
  const diskText = readText(path)
  const detail: ConflictDetail = { expected, actual, diskText }
  throw new CmsError(
    'CONFLICT',
    '文件已被外部修改，已阻止保存以避免覆盖',
    '请对比「磁盘版本」与「缓冲版本」后再决定：重新加载磁盘版本，或在确认后强制覆盖',
    detail
  )
}