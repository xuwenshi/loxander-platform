import { useEffect, useState } from 'react'
import EditorPane from './components/EditorPane'
import PromptDialog from './components/PromptDialog'
import PublishPanel from './components/PublishPanel'
import Sidebar from './components/Sidebar'
import { useCms } from './store'
import { metaOf, sectionColor } from './theme'

/**
 * P1 界面外壳：一个 grid 主壳 + 由 settings.themeMode 决定的四种模式。
 * - soft      柔和编辑：分区树 | 条目列表 | 编辑区
 * - dashboard 管理控制台：分区树 | 内容概览
 * - writing   专注写作：只有编辑区（隐藏侧栏/条目/发布入口）
 * - developer 开发者：分区树 | Git 闸门与发布
 * 模式切换只改 <html data-mode> 与列模板，编辑区组件保持挂载。
 */

type DialogKind = 'create' | 'rename'

/** 管理模式的内容概览（P1 仅统计；列表筛选、发布历史在 P3 补齐） */
function DashboardPane() {
  const cms = useCms()
  const total = cms.sections.reduce((sum, item) => sum + item.count, 0)

  return (
    <section className="flex min-w-0 flex-col gap-3 overflow-auto p-6">
      <div>
        <h2 className="m-0 text-[16px]">内容概览</h2>
        <p className="mt-1 mb-0 text-[12px] break-all text-[var(--muted)]">
          共 {total} 篇 · 工作区 {cms.workspaceRoot || '未配置'}
        </p>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
        {cms.sections.map((item) => (
          <div
            key={item.section}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 shadow-[var(--shadow)]"
            // 左侧色条用该分区的主题色，让四张卡片一眼可区分
            style={{
              borderLeftWidth: 3,
              borderLeftColor: sectionColor(item.section)
            }}
          >
            <div className="text-[12px] text-[var(--muted)]">content/{item.section}</div>
            <div className="mt-1.5 text-[22px] leading-none" style={{ color: sectionColor(item.section) }}>
              {item.count}
            </div>
          </div>
        ))}
      </div>

      <p className="m-0 text-[12px] text-[var(--muted)]">
        状态筛选、发布历史与最近操作记录将在 P3 补齐（数据源：publish-state.json）。
      </p>
    </section>
  )
}

export default function App() {
  const cms = useCms()
  const [dialog, setDialog] = useState<DialogKind | null>(null)

  useEffect(() => {
    void cms.bootstrap()
    // 只在首次挂载时初始化
  }, [])

  const meta = metaOf(cms.themeMode)
  const current = cms.sections.find((item) => item.section === cms.activeSection)

  // ---- 内容管理闭环（P3）：新建 / 重命名 / 删除（破坏性操作前均二次确认） ----

  const handleCreate = () => {
    if (!current) return
    setDialog('create')
  }

  const handleRename = () => {
    if (!cms.activeSlug) return
    setDialog('rename')
  }

  const handleDelete = () => {
    if (!cms.activeSlug) return
    const label = `content/${cms.activeSection}/${cms.activeSlug}.md`
    if (!window.confirm(`删除 ${label}？删除前会自动备份到 CMS 的备份目录。`)) return
    void cms.removeEntry(cms.activeSlug)
  }

  return (
    <div className={`grid h-full overflow-hidden ${cms.sidebarCollapsed ? meta.columnsCollapsed : meta.columns}`}>
      {meta.showSidebar ? <Sidebar /> : null}

      {meta.showEntries ? (
        <section className="entries h-full min-w-0">
          <div className="entries-head">
            <h2>{current ? `content/${current.section}` : '内容'}</h2>
            <button type="button" className="ghost" onClick={handleCreate} disabled={!current}>
              + 新建
            </button>
          </div>
          <div className="entries-list">
            {current?.entries.map((entry) => (
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
                </div>
              </div>
            ))}
            {current && current.count === 0 ? <p className="hint">该分区暂无 Markdown 文件。</p> : null}
          </div>
        </section>
      ) : null}

      {meta.mainPane === 'dashboard' ? <DashboardPane /> : null}

      {meta.mainPane === 'publish' ? <PublishPanel onBack={() => void cms.setThemeMode('soft')} /> : null}

      {/* 编辑区常驻挂载：非编辑模式只是隐藏，避免卸载 CodeMirror 丢失焦点与撤销栈 */}
      <EditorPane
        hidden={meta.mainPane !== 'editor'}
        showForm={meta.showForm}
        compact={cms.themeMode === 'writing'}
        onRename={handleRename}
        onDelete={handleDelete}
        onExitFocus={() => void cms.setThemeMode('soft')}
      />

      {dialog === 'create' ? (
        <PromptDialog
          title={`新建 content/${cms.activeSection}/`}
          confirmText="创建"
          fields={[
            { key: 'slug', label: '文件名（slug）', placeholder: '字母 / 数字 / - / _' },
            { key: 'title', label: '标题（可留空）', placeholder: '留空则用文件名' }
          ]}
          onCancel={() => setDialog(null)}
          onConfirm={(values) => {
            setDialog(null)
            void cms.createEntry(values.slug.trim(), values.title.trim() || undefined)
          }}
        />
      ) : null}

      {dialog === 'rename' && cms.activeSlug ? (
        <PromptDialog
          title="重命名"
          confirmText="重命名"
          fields={[{ key: 'slug', label: '新文件名（slug）', defaultValue: cms.activeSlug }]}
          onCancel={() => setDialog(null)}
          onConfirm={(values) => {
            const from = cms.activeSlug
            const next = values.slug.trim()
            setDialog(null)
            if (from && next && next !== from) void cms.renameEntry(from, next)
          }}
        />
      ) : null}
    </div>
  )
}