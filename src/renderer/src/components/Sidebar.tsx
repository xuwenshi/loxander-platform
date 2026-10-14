import { useEffect, useState } from 'react'
import ThemeSelector from './ThemeSelector'
import { sectionColor } from '../theme'
import { useCms } from '../store'

/**
 * 预览端口输入：受控于本地 state，失焦 / 回车才落盘，
 * 避免每敲一位数字就触发主进程重启 dev server。
 */
function PreviewPortField() {
  const cms = useCms()
  const [draft, setDraft] = useState(String(cms.previewPort))

  // 外部（settings.json / bootstrap）变化时同步回输入框
  useEffect(() => {
    setDraft(String(cms.previewPort))
  }, [cms.previewPort])

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed)) {
      setDraft(String(cms.previewPort))
      return
    }
    void cms.setPreviewPort(parsed)
  }

  return (
    <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--muted)]">
      <span>预览端口</span>
      <input
        className="w-[72px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-right text-[12px] text-[var(--text)]"
        inputMode="numeric"
        min={1024}
        max={65535}
        title="被占用时自动向后寻找空闲端口；留空或非法值会还原"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(String(cms.previewPort))
        }}
      />
    </label>
  )
}

/**
 * 左导航（P1）：模式选择 + 内容分区树 + 工作区操作。
 * 布局全部使用 Tailwind 工具类（flex / gap / padding / 尺寸），
 * 颜色一律引用 CSS 变量，因此换主题时这里不需要改任何代码。
 */
export default function Sidebar() {
  const cms = useCms()
  const collapsed = cms.sidebarCollapsed
  const inEditor = cms.themeMode === 'soft'

  return (
    <aside className="flex min-w-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--panel)]">
      <div className={`flex items-center gap-2 px-3 pt-3 pb-2 ${collapsed ? 'justify-center' : 'justify-between'}`}>
        {collapsed ? null : (
          <h1 className="m-0 text-[11px] tracking-[0.05em] text-[var(--muted)] uppercase">my-blog CMS</h1>
        )}
        <button
          type="button"
          className="ghost px-2 py-1"
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          onClick={cms.toggleSidebar}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {collapsed ? null : (
        <div className="px-3 pb-3">
          <ThemeSelector />
        </div>
      )}

      <nav className="flex-1 overflow-auto px-3 pb-3">
        {collapsed ? null : (
          <h2 className="m-0 mb-2 text-[11px] tracking-[0.05em] text-[var(--muted)] uppercase">内容分区</h2>
        )}
        <div className="flex flex-col gap-1">
          {cms.sections.map((item) => {
            const active = item.section === cms.activeSection && inEditor
            return (
              <button
                key={item.section}
                type="button"
                title={collapsed ? item.section : undefined}
                className={`flex w-full items-center rounded-[var(--radius)] border px-2 py-1.5 text-left text-[12px] ${
                  collapsed ? 'justify-center' : 'justify-between'
                } ${
                  active
                    ? 'border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'border-transparent text-[var(--text)] hover:bg-[var(--card-hover)]'
                }`}
                onClick={() => {
                  // 分区导航属于编辑场景：从其它模式点进来时先回到柔和编辑模式
                  if (cms.themeMode !== 'soft') void cms.setThemeMode('soft')
                  cms.selectSection(item.section)
                }}
              >
                <span className="truncate">{collapsed ? item.section.slice(0, 3) : item.section}</span>
                {collapsed ? null : (
                  // 分区计数用该分区的主题色做药丸，让侧栏有可辨识的颜色
                  <span
                    className="rounded-full border px-1.5 text-[11px] leading-4"
                    style={{
                      color: sectionColor(item.section),
                      borderColor: `color-mix(in srgb, ${sectionColor(item.section)} 40%, transparent)`,
                      backgroundColor: `color-mix(in srgb, ${sectionColor(item.section)} 16%, transparent)`
                    }}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </nav>

      <div className="flex flex-col gap-1.5 border-t border-[var(--border)] px-3 py-3">
        <button type="button" className="ghost block" onClick={() => void cms.validateWorkspace()}>
          校验全仓
        </button>
        <button type="button" className="ghost block" onClick={() => void cms.refreshList()}>
          刷新清单
        </button>
        <button type="button" className="ghost block" onClick={() => void cms.pickWorkspace()}>
          选择工作区…
        </button>
        {collapsed ? null : <PreviewPortField />}
        {collapsed ? null : <div className="ws-path">{cms.workspaceRoot || '未配置工作区'}</div>}
        {!cms.bridgeOk ? <div className="err tiny">preload 桥未就绪</div> : null}
      </div>
    </aside>
  )
}