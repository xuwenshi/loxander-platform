import { useEffect, useState } from 'react'
import type { ContentGroup } from '../../preload/api'
import EditorPane from './components/EditorPane'
import EntryList from './components/EntryList'
import PreviewPane from './components/PreviewPane'
import PromptDialog from './components/PromptDialog'
import PublishPanel from './components/PublishPanel'
import Sidebar from './components/Sidebar'
import { useCms } from './store'
import { layoutColumns, metaOf, sectionColor } from './theme'

/**
 * P1 界面外壳：一个 grid 主壳 + 由 settings.themeMode 决定的四种模式。
 * - soft      柔和编辑：分区树 | 条目列表 | 编辑区
 * - dashboard 管理控制台：分区树 | 内容概览
 * - writing   专注写作：只有编辑区（隐藏侧栏/条目/发布入口）
 * - developer 开发者：分区树 | Git 闸门与发布
 * 模式切换只改 <html data-mode> 与列模板，编辑区组件保持挂载。
 */

type DialogKind = 'create' | 'rename' | 'group-new' | 'group-rename'

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
  /** 正在改名/删除的文件夹（group-rename 弹窗需要它） */
  const [groupTarget, setGroupTarget] = useState<ContentGroup | null>(null)

  useEffect(() => {
    void cms.bootstrap()
    // 订阅外部改动；卸载时退订，避免热更新重复注册监听
    const unsubscribe = cms.initWatcher()
    // 订阅预览状态 / 自动发布 / 部署回读事件
    const unsubscribePreview = cms.initPreview()
    return () => {
      unsubscribe()
      unsubscribePreview()
    }
    // 只在首次挂载时初始化
  }, [])

  const meta = metaOf(cms.themeMode)
  const current = cms.sections.find((item) => item.section === cms.activeSection)
  // 只有 soft 模式在预览展开时才有第 4 列；其余模式 previewVisible 会被 PreviewPane 的 hidden 忽略
  const columns = layoutColumns(meta, { previewVisible: cms.previewVisible, collapsed: cms.sidebarCollapsed })

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
    <div className={`grid h-full overflow-hidden ${columns}`}>
      {meta.showSidebar ? <Sidebar /> : null}

      {meta.showEntries ? (
        <EntryList
          onNewEntry={handleCreate}
          onNewGroup={() => setDialog('group-new')}
          onRenameGroup={(group) => {
            setGroupTarget(group)
            setDialog('group-rename')
          }}
        />
      ) : null}

      {meta.mainPane === 'dashboard' ? <DashboardPane /> : null}

      {meta.mainPane === 'publish' ? <PublishPanel onBack={() => void cms.setThemeMode('soft')} /> : null}

      {/* 编辑区常驻挂载：非编辑模式只是隐藏，避免卸载 CodeMirror 丢失焦点与撤销栈 */}
      <EditorPane
        hidden={meta.mainPane !== 'editor'}
        showForm={meta.showForm}
        compact={cms.themeMode === 'writing'}
        allowPreview={meta.mode === 'soft'}
        onRename={handleRename}
        onDelete={handleDelete}
        onExitFocus={() => void cms.setThemeMode('soft')}
      />

      {/* 本地实时预览列（A）：常驻挂载（webview 不卸载），仅 soft 模式且用户展开时可见 */}
      <PreviewPane hidden={meta.mode !== 'soft' || !cms.previewVisible} />

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

      {dialog === 'group-new' ? (
        <PromptDialog
          title={`在 content/${cms.activeSection}/ 下新建文件夹`}
          confirmText="创建"
          fields={[{ key: 'name', label: '文件夹名', placeholder: '例如：2026 / 随笔' }]}
          onCancel={() => setDialog(null)}
          onConfirm={(values) => {
            const name = values.name.trim()
            setDialog(null)
            if (name) void cms.createGroup(name)
          }}
        />
      ) : null}

      {dialog === 'group-rename' && groupTarget ? (
        <PromptDialog
          title="重命名文件夹"
          confirmText="重命名"
          fields={[{ key: 'name', label: '文件夹名', defaultValue: groupTarget.name }]}
          onCancel={() => {
            setGroupTarget(null)
            setDialog(null)
          }}
          onConfirm={(values) => {
            const name = values.name.trim()
            const target = groupTarget
            setGroupTarget(null)
            setDialog(null)
            if (target && name && name !== target.name) void cms.renameGroup(target.id, name)
          }}
        />
      ) : null}
    </div>
  )
}