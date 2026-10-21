import { resolve, sep } from 'node:path'
import { CmsError } from '../errors'

/**
 * 安全基线之一：路径守卫。
 * IPC 是信任边界，renderer 传入的 section / slug 一律不可信；
 * 所有落到文件系统的路径都必须先经本模块校验，越界直接拒绝。
 */

const SAFE_SLUG = /^[a-zA-Z0-9._-]+$/

export function assertSafeSlug(slug: unknown): string {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 200) {
    throw new CmsError('INVALID_SLUG', '文件名不合法（长度或类型错误）', 'slug 必须是 1~200 字符的字符串')
  }
  if (!SAFE_SLUG.test(slug) || slug === '.' || slug === '..') {
    throw new CmsError('INVALID_SLUG', `文件名含非法字符：${slug}`, '仅允许字母、数字、点、下划线、连字符')
  }
  return slug
}

/** 将 path 解析到 root 内，否则抛 PATH_ESCAPE。用于阻断 ../../ 形式的越权写。 */
export function resolveInsideRoot(root: string, ...segments: string[]): string {
  const base = resolve(root)
  const target = resolve(base, ...segments)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new CmsError('PATH_ESCAPE', '目标路径越出工作区根目录，已拒绝访问', `根目录：${base}`)
  }
  return target
}