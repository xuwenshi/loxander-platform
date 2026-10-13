import { useState, type ReactElement } from 'react'
import type { ContentEntry, ContentGroup } from '../../../preload/api'
import { useCms } from '../store'

/**
 * 条目列表面板：把当前分区内的条目按「虚拟分组（文件夹）」分组展示。
 *
 * 分组只存在于 CMS 侧（<userData>/settings.json），磁盘结构完全不变，博客照常发布
 * ——博客读取内容不递归，真建子目录会让文章不上站（见 groupService 顶部注释）。
 * 折叠态是纯 UI 瞬时状态，不持久化。
 */
export default function EntryList({
  onNewEntry,
  onNewGroup,
  onRenameGroup
}: {
  onNewEntry: () => void
  onNewGroup: () => void
  onRenameGroup: (group: ContentGroup) => void
}) {
  const cms = useCms()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const current = cms.sections.find((item) => item.section === cms.activeSection)
  const groups = current?.groups ?? []
  const entries = current?.entries ?? []
  const ungrouped = entries.filter((entry) => !entry.groupId)

  const toggle = (key: string): void => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

  const handleDeleteGroup = (group: ContentGroup): void => {
    const ok = window.confirm(
      `删除文件夹「${group.name}」？\n\n只会取消归类：其中的条目会回到「未分组」，不会删除任何 .md 文件。`
    )
    if (ok) void cms.deleteGroup(group.id)
  }

  const renderEntry = (entry: ContentEntry): ReactElement => (
    <div
      key={entry.slug}
      className={`entry${entry.slug === cms.activeSlug ? ' active' : ''}`}
      onClick={() => void cms.openEntry(entry.slug)}
    >
      <div className="entry-title">
        {entry.title ?? <span className="badge err-badge">缺 title</span>}
      </div>
      <div className="entry-meta">
        <span className="slug">{entry.slug}</span>
        <span>{entry.date ?? '—'}</span>
        {entry.draft ? <span className="badge draft">draft</span> : null}
        {entry.parseError ? <span className="badge err-badge">解析失败</span> : null}
        {groups.length > 0 ? (
          <select
            className="entry-group-select"
            value={entry.groupId ?? ''}
            title="归入文件夹"
            // 拦住冒泡：否则点下拉会顺带触发条目行的「打开文档」
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) => void cms.assignEntry(entry.slug, event.target.value || null)}
          >
            <option value="">未分组</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  )

  /** 一个可折叠分组；group 缺省表示「未分组」桶（没有改名/删除动作） */
  const renderGroup = (
    key: string,
    label: string,
    list: ContentEntry[],
    group?: ContentGroup
  ): ReactElement => (
    <div className="entry-group" key={key}>
      <div className="folder-head">
        <button type="button" className="folder-toggle" onClick={() => toggle(key)}>
          <span className="folder-caret">{collapsed[key] ? '▸' : '▾'}</span>
          <span className="folder-name">{label}</span>
          <span className="folder-count">{list.length}</span>
        </button>
        {group ? (
          <span className="folder-actions">
            <button type="button" className="ghost tiny" onClick={() => onRenameGroup(group)}>
              改名
            </button>
            <button type="button" className="ghost tiny" onClick={() => handleDeleteGroup(group)}>
              删除
            </button>
          </span>
        ) : null}
      </div>
      {collapsed[key] ? null : <div className="folder-body">{list.map(renderEntry)}</div>}
    </div>
  )

  return (
    <section className="entries h-full min-w-0">
      <div className="entries-head">
        <h2>{current ? `content/${current.section}` : '内容'}</h2>
        <span className="entries-head-actions">
          <button
            type="button"
            className="ghost"
            title="在当前分区新建文件夹（只影响 CMS 展示，不改磁盘结构）"
            onClick={onNewGroup}
            disabled={!current}
          >
            + 文件夹
          </button>
          <button type="button" className="ghost" onClick={onNewEntry} disabled={!current}>
            + 新建
          </button>
        </span>
      </div>
      <div className="entries-list">
        {groups.map((group) =>
          renderGroup(
            group.id,
            group.name,
            entries.filter((entry) => entry.groupId === group.id),
            group
          )
        )}
        {groups.length > 0 && ungrouped.length > 0 ? renderGroup('__ungrouped__', '未分组', ungrouped) : null}
        {groups.length === 0 ? entries.map(renderEntry) : null}
        {current && current.count === 0 ? <p className="hint">该分区暂无 Markdown 文件。</p> : null}
      </div>
    </section>
  )
}