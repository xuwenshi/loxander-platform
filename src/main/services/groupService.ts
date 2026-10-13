import { CmsError } from '../errors'
import { CONTENT_SECTIONS, type ContentSection } from './schemaService'

/**
 * 虚拟分组（文件夹）：只存在于 CMS 侧的归类元数据，**不落进博客仓库、不改磁盘结构**。
 *
 * 为什么不建真实目录：博客读取内容是不递归的（`readdirSync(dir).filter(f => f.endsWith('.md'))`），
 * 在 content/<section>/ 下建子目录会让文章静默不上站；要发布就得改博客代码，违反「my-blog 零改动」约束。
 * 因此分组只存 <userData>/settings.json，正文文件始终留在分区根目录。
 *
 * 本模块是纯函数（无 electron / 无 fs），便于单测；读写 settings.json 由 settingsService 负责。
 */

/** 一个虚拟分组（文件夹） */
export interface ContentGroup {
  /** 稳定标识：与名称解耦，改名不丢归属 */
  id: string
  name: string
}

/** 分组表：分区名 → 该分区下的分组（保持创建顺序） */
export type GroupTable = Record<string, ContentGroup[]>

/** 归属表：`<section>/<slug>` → groupId；键不存在 = 未分组 */
export type GroupAssignments = Record<string, string>

export interface GroupStore {
  groups: GroupTable
  assignments: GroupAssignments
}

/** 名称长度上限（仅展示用，不是路径，故只做长度与重复校验） */
export const GROUP_NAME_MAX = 40

export function emptyGroupStore(): GroupStore {
  return { groups: {}, assignments: {} }
}

/** 归属键：用 slug 而非文件名，与 entryService 的标识保持一致 */
export function entryKey(section: string, slug: string): string {
  return `${section}/${slug}`
}

export function makeGroupId(): string {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function groupsOf(store: GroupStore, section: string): ContentGroup[] {
  return store.groups[section] ?? []
}

/** 取条目的分组 id；若指向的分组已被删除则视为未分组 */
export function groupIdOf(store: GroupStore, section: string, slug: string): string | null {
  const id = store.assignments[entryKey(section, slug)]
  if (!id) return null
  return groupsOf(store, section).some((group) => group.id === id) ? id : null
}

function clone(store: GroupStore): GroupStore {
  return { groups: { ...store.groups }, assignments: { ...store.assignments } }
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new CmsError('GROUP_NAME', '文件夹名必须是文本', '请填写 1–40 个字符的名称')
  }
  const name = raw.trim()
  if (name.length === 0) {
    throw new CmsError('GROUP_NAME', '文件夹名不能为空', '请填写 1–40 个字符的名称')
  }
  if (name.length > GROUP_NAME_MAX) {
    throw new CmsError('GROUP_NAME', `文件夹名过长（上限 ${GROUP_NAME_MAX} 字符）`, '请缩短名称')
  }
  return name
}

function requireGroup(store: GroupStore, section: string, id: string): ContentGroup {
  const target = groupsOf(store, section).find((group) => group.id === id)
  if (!target) {
    throw new CmsError('GROUP_NOT_FOUND', `文件夹不存在：${id}`, '它可能已在别处被删除，请刷新列表')
  }
  return target
}

/** 新建文件夹：同分区内重名即拒绝（按 trim 后的名称精确比较） */
export function createGroup(store: GroupStore, section: string, rawName: unknown): GroupStore {
  const name = normalizeName(rawName)
  const list = groupsOf(store, section)
  if (list.some((group) => group.name === name)) {
    throw new CmsError('GROUP_EXISTS', `文件夹「${name}」已存在`, '请换一个名称')
  }
  const next = clone(store)
  next.groups[section] = [...list, { id: makeGroupId(), name }]
  return next
}

export function renameGroup(store: GroupStore, section: string, id: string, rawName: unknown): GroupStore {
  const name = normalizeName(rawName)
  const list = groupsOf(store, section)
  requireGroup(store, section, id)
  if (list.some((group) => group.name === name && group.id !== id)) {
    throw new CmsError('GROUP_EXISTS', `文件夹「${name}」已存在`, '请换一个名称')
  }
  const next = clone(store)
  next.groups[section] = list.map((group) => (group.id === id ? { ...group, name } : group))
  return next
}

/**
 * 删除文件夹：只取消归类，**绝不删除任何 .md 文件**。
 * 原属该分组的条目回到「未分组」。
 */
export function deleteGroup(store: GroupStore, section: string, id: string): GroupStore {
  requireGroup(store, section, id)
  const next = clone(store)
  next.groups[section] = groupsOf(store, section).filter((group) => group.id !== id)
  const prefix = `${section}/`
  for (const key of Object.keys(next.assignments)) {
    if (next.assignments[key] === id && key.startsWith(prefix)) delete next.assignments[key]
  }
  return next
}

/** 归类：groupId 传 null/空串 = 移出到「未分组」 */
export function assignEntry(
  store: GroupStore,
  section: string,
  slug: string,
  groupId: string | null | undefined
): GroupStore {
  const key = entryKey(section, slug)
  const next = clone(store)
  if (groupId === null || groupId === undefined || String(groupId).length === 0) {
    delete next.assignments[key]
    return next
  }
  const id = String(groupId)
  requireGroup(store, section, id)
  next.assignments[key] = id
  return next
}

/** 条目改名：把归属键从旧 slug 迁到新 slug（无归属则原样返回） */
export function moveAssignment(store: GroupStore, section: string, fromSlug: string, toSlug: string): GroupStore {
  const from = entryKey(section, fromSlug)
  const to = entryKey(section, toSlug)
  if (from === to) return store
  const id = store.assignments[from]
  if (!id) return store
  const next = clone(store)
  delete next.assignments[from]
  next.assignments[to] = id
  return next
}

/** 条目删除：清掉其归属键（无归属则原样返回） */
export function dropAssignment(store: GroupStore, section: string, slug: string): GroupStore {
  const key = entryKey(section, slug)
  if (!store.assignments[key]) return store
  const next = clone(store)
  delete next.assignments[key]
  return next
}

function isKnownSection(value: string): value is ContentSection {
  return (CONTENT_SECTIONS as readonly string[]).includes(value)
}

/**
 * 收敛落盘值（可能被手工改坏）：丢弃形状非法的分组、丢弃指向不存在分组的归属。
 * 自愈式——宁可少显示一个文件夹，也不要让 UI 拿到悬空 id。
 */
export function sanitizeGroups(raw: unknown): GroupStore {
  const store = emptyGroupStore()
  if (!raw || typeof raw !== 'object') return store
  const input = raw as { groups?: unknown; assignments?: unknown }

  if (input.groups && typeof input.groups === 'object') {
    for (const [section, value] of Object.entries(input.groups as Record<string, unknown>)) {
      if (!isKnownSection(section) || !Array.isArray(value)) continue
      const list: ContentGroup[] = []
      for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const { id, name } = item as { id?: unknown; name?: unknown }
        if (typeof id !== 'string' || id.length === 0) continue
        if (typeof name !== 'string') continue
        const trimmed = name.trim()
        if (trimmed.length === 0 || trimmed.length > GROUP_NAME_MAX) continue
        if (list.some((group) => group.id === id || group.name === trimmed)) continue
        list.push({ id, name: trimmed })
      }
      if (list.length > 0) store.groups[section] = list
    }
  }

  if (input.assignments && typeof input.assignments === 'object') {
    for (const [key, value] of Object.entries(input.assignments as Record<string, unknown>)) {
      if (typeof value !== 'string' || value.length === 0) continue
      const slash = key.indexOf('/')
      if (slash <= 0 || slash === key.length - 1) continue
      const section = key.slice(0, slash)
      if (!isKnownSection(section)) continue
      if (!(store.groups[section] ?? []).some((group) => group.id === value)) continue
      store.assignments[key] = value
    }
  }

  return store
}