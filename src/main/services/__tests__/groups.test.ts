import { describe, expect, it } from 'vitest'
import type { CmsError } from '../../errors'
import {
  assignEntry,
  createGroup,
  deleteGroup,
  dropAssignment,
  emptyGroupStore,
  entryKey,
  groupIdOf,
  groupsOf,
  moveAssignment,
  renameGroup,
  sanitizeGroups,
  type GroupStore
} from '../groupService'

/**
 * 虚拟分组（文件夹）的门禁：全是纯函数，不碰 fs / electron。
 * 重点覆盖两件容易出错的事：
 *  1) 归属表以 `section/slug` 为键，改名要迁移、删除要清理，否则归类会丢或悬空；
 *  2) 落盘值可能被手工改坏，sanitizeGroups 必须自愈而不是把坏数据透给 UI。
 */

/** 取一次调用抛出的错误码；未抛则返回 'NO_THROW' */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return (err as CmsError).code
  }
  return 'NO_THROW'
}

/** 造一个「blog 分区下有一个分组 A，且 demo 属于 A」的 store */
function storeWithGroup(name = 'A'): { store: GroupStore; id: string } {
  const store = createGroup(emptyGroupStore(), 'blog', name)
  const id = store.groups.blog[0].id
  return { store: assignEntry(store, 'blog', 'demo', id), id }
}

describe('createGroup：新建文件夹', () => {
  it('新建后带上稳定 id，并保持创建顺序', () => {
    const first = createGroup(emptyGroupStore(), 'blog', '随笔')
    const second = createGroup(first, 'blog', '技术')
    expect(groupsOf(second, 'blog').map((group) => group.name)).toEqual(['随笔', '技术'])
    expect(groupsOf(second, 'blog')[0].id).toBeTruthy()
    expect(groupsOf(second, 'blog')[0].id).not.toBe(groupsOf(second, 'blog')[1].id)
  })

  it('名称两端空白会被去掉', () => {
    const store = createGroup(emptyGroupStore(), 'blog', '  随笔  ')
    expect(groupsOf(store, 'blog')[0].name).toBe('随笔')
  })

  it('同一分区内重名被拒绝', () => {
    const store = createGroup(emptyGroupStore(), 'blog', '随笔')
    expect(codeOf(() => createGroup(store, 'blog', '随笔'))).toBe('GROUP_EXISTS')
    // 不同分区互不影响
    expect(codeOf(() => createGroup(store, 'diary', '随笔'))).toBe('NO_THROW')
  })

  it('空名 / 超长 / 非文本被拒绝', () => {
    expect(codeOf(() => createGroup(emptyGroupStore(), 'blog', '   '))).toBe('GROUP_NAME')
    expect(codeOf(() => createGroup(emptyGroupStore(), 'blog', 'x'.repeat(41)))).toBe('GROUP_NAME')
    expect(codeOf(() => createGroup(emptyGroupStore(), 'blog', 123))).toBe('GROUP_NAME')
  })

  it('不修改传入的 store（纯函数）', () => {
    const before = emptyGroupStore()
    createGroup(before, 'blog', '随笔')
    expect(before).toEqual({ groups: {}, assignments: {} })
  })
})

describe('renameGroup：重命名', () => {
  it('改名后 id 不变（归属不丢）', () => {
    const { store, id } = storeWithGroup('旧名')
    const next = renameGroup(store, 'blog', id, '新名')
    expect(groupsOf(next, 'blog')[0]).toEqual({ id, name: '新名' })
    expect(groupIdOf(next, 'blog', 'demo')).toBe(id)
  })

  it('改成自己原来的名字允许通过', () => {
    const { store, id } = storeWithGroup('同名')
    expect(codeOf(() => renameGroup(store, 'blog', id, '同名'))).toBe('NO_THROW')
  })

  it('撞上别的分组名被拒绝', () => {
    const { store, id } = storeWithGroup('A')
    const two = createGroup(store, 'blog', 'B')
    expect(codeOf(() => renameGroup(two, 'blog', id, 'B'))).toBe('GROUP_EXISTS')
  })

  it('目标分组不存在时报 GROUP_NOT_FOUND', () => {
    expect(codeOf(() => renameGroup(emptyGroupStore(), 'blog', 'g-nope', 'x'))).toBe('GROUP_NOT_FOUND')
  })
})

describe('deleteGroup：删除文件夹只取消归类', () => {
  it('分组被移除，其下条目回到「未分组」，其它分组不受影响', () => {
    const { store, id } = storeWithGroup('A')
    const withB = createGroup(store, 'blog', 'B')
    const next = deleteGroup(withB, 'blog', id)
    expect(groupsOf(next, 'blog').map((group) => group.name)).toEqual(['B'])
    expect(groupIdOf(next, 'blog', 'demo')).toBeNull()
    expect(next.assignments[entryKey('blog', 'demo')]).toBeUndefined()
  })

  it('分组不存在时报 GROUP_NOT_FOUND', () => {
    expect(codeOf(() => deleteGroup(emptyGroupStore(), 'blog', 'g-nope'))).toBe('GROUP_NOT_FOUND')
  })
})

describe('assignEntry / groupIdOf：归类', () => {
  it('归入分组后能读回，传 null 移出', () => {
    const { store, id } = storeWithGroup()
    expect(groupIdOf(store, 'blog', 'demo')).toBe(id)
    const cleared = assignEntry(store, 'blog', 'demo', null)
    expect(groupIdOf(cleared, 'blog', 'demo')).toBeNull()
  })

  it('指向不存在的分组时报 GROUP_NOT_FOUND', () => {
    expect(codeOf(() => assignEntry(emptyGroupStore(), 'blog', 'demo', 'g-nope'))).toBe('GROUP_NOT_FOUND')
  })

  it('归属指向已删除的分组时退化为未分组（悬空自愈）', () => {
    const { store, id } = storeWithGroup()
    const stale = { groups: {}, assignments: { [entryKey('blog', 'demo')]: id } }
    expect(groupIdOf(stale, 'blog', 'demo')).toBeNull()
    expect(groupIdOf(store, 'blog', 'other')).toBeNull()
  })
})

describe('moveAssignment / dropAssignment：条目改名与删除的级联', () => {
  it('改名把归属迁到新 slug', () => {
    const { store, id } = storeWithGroup()
    const next = moveAssignment(store, 'blog', 'demo', 'demo-2')
    expect(next.assignments[entryKey('blog', 'demo-2')]).toBe(id)
    expect(next.assignments[entryKey('blog', 'demo')]).toBeUndefined()
  })

  it('无归属时原样返回同一个引用（避免无谓写盘）', () => {
    const store = emptyGroupStore()
    expect(moveAssignment(store, 'blog', 'a', 'b')).toBe(store)
    expect(dropAssignment(store, 'blog', 'a')).toBe(store)
  })

  it('删除条目清掉归属键', () => {
    const { store } = storeWithGroup()
    const next = dropAssignment(store, 'blog', 'demo')
    expect(next.assignments[entryKey('blog', 'demo')]).toBeUndefined()
    expect(groupsOf(next, 'blog')).toHaveLength(1)
  })
})

describe('sanitizeGroups：落盘值自愈', () => {
  it('非对象输入退化为空', () => {
    expect(sanitizeGroups(null)).toEqual({ groups: {}, assignments: {} })
    expect(sanitizeGroups('nope')).toEqual({ groups: {}, assignments: {} })
    expect(sanitizeGroups(42)).toEqual({ groups: {}, assignments: {} })
  })

  it('丢弃形状非法的分组项与重复项', () => {
    const store = sanitizeGroups({
      groups: {
        blog: [
          { id: 'g1', name: 'A' },
          { id: 'g1', name: 'A2' }, // id 重复
          { id: 'g2', name: 'A' }, // 名称重复
          { id: 'g3', name: '  ' }, // 空名
          { name: '没有 id' },
          'nope'
        ],
        nosuchsection: [{ id: 'g9', name: 'X' }] // 未知分区
      }
    })
    expect(store.groups.blog).toEqual([{ id: 'g1', name: 'A' }])
    expect(store.groups.nosuchsection).toBeUndefined()
  })

  it('丢弃悬空归属与未知分区的归属', () => {
    const store = sanitizeGroups({
      groups: { blog: [{ id: 'g1', name: 'A' }] },
      assignments: {
        'blog/demo': 'g1',
        'blog/gone': 'g-nope', // 分组不存在
        'nosuchsection/x': 'g1', // 分区不存在
        'blog/bad-key': '' // 空值
      }
    })
    expect(store.assignments).toEqual({ 'blog/demo': 'g1' })
  })
})