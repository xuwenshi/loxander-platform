import { useMemo, useState } from 'react'
import DiffView from './DiffView'
import FrontmatterForm from './FrontmatterForm'
import MarkdownEditor from './MarkdownEditor'
import { renderMarkdown } from '../markdown'
import { useCms } from '../store'
import { EDITOR_LAYOUT_META } from '../theme'

/**
 * 编辑主区：文档头（保存/重命名/删除）+ 冲突横幅 + frontmatter 表单 + 写作区。
 *
 * 写作区布局由 settings.editorLayout 驱动（编辑器 / 分栏 / 预览），差异预览是独立的查看态。
 * 编辑器组件**始终挂载**（只用 hidden 隐藏），无论切布局、切差异还是切主题模式，
 * 都靠可见性切换而不是卸载，避免 CodeMirror 丢焦点与撤销栈。
 */
export default function EditorPane({
  showForm,
  compact,
  hidden,
  onRename,
  onDelete,
  onExitFocus
}: {
  /** 是否显示 frontmatter 表单列（专注写作模式关闭，把版面让给正文） */
  showForm: boolean
  /** 专注写作模式：精简操作区 */
  compact: boolean
  hidden: boolean
  onRename: () => void
  onDelete: () => void
  onExitFocus: () => void
}) {
  const cms = useCms()
  /** 差异预览是独立查看态：打开时盖住写作区，但编辑器仍挂载在下面 */
  const [showDiff, setShowDiff] = useState(false)
  const schema = cms.schemas[cms.activeSection]
  // 只要布局会露出预览（分栏 / 仅预览）就实时渲染；仅编辑器时省掉这次渲染
  const html = useMemo(
    () => (cms.editorLayout === 'editor' ? '' : renderMarkdown(cms.body)),
    [cms.editorLayout, cms.body]
  )
  const formIssues = useMemo(
    () => [...cms.workspaceIssues.blocking, ...cms.workspaceIssues.warnings],
    [cms.workspaceIssues]
  )

  return (
    <main className="editor-pane h-full" hidden={hidden}>
      {cms.doc && schema ? (
        <>
          <header className="doc-head">
            <div className="doc-title">
              {String(cms.fields.title ?? cms.fields.name ?? cms.activeSlug)}
              <span className="path">{cms.doc.file}</span>
            </div>
            <div className="doc-actions">
              <span className={cms.isDirty() ? 'dirty on' : 'dirty'}>{cms.isDirty() ? '有未保存改动' : '已同步'}</span>
              {compact ? null : (
                <>
                  <button type="button" className="ghost" onClick={() => void cms.runPreview()}>
                    查看差异
                  </button>
                  <button type="button" className="ghost" onClick={onRename}>
                    重命名
                  </button>
                  <button type="button" className="ghost danger-ghost" onClick={onDelete}>
                    删除
                  </button>
                </>
              )}
              {compact ? (
                <button type="button" className="ghost" onClick={onExitFocus}>
                  退出专注
                </button>
              ) : null}
              <button type="button" className="ghost" onClick={cms.discard} disabled={!cms.isDirty()}>
                放弃改动
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void cms.save()}
                disabled={cms.busy || !cms.isDirty()}
              >
                {cms.busy ? '保存中…' : '保存到磁盘'}
              </button>
            </div>
          </header>

          {cms.conflict ? (
            <div className="banner conflict">
              <div>
                <strong>{cms.conflict.message}</strong>
                {cms.conflict.hint ? <div className="hint">{cms.conflict.hint}</div> : null}
              </div>
              <div className="banner-actions">
                <button type="button" className="ghost" onClick={() => void cms.reloadFromDisk()}>
                  重新加载磁盘版本
                </button>
                <button type="button" className="danger" onClick={() => void cms.save(true)}>
                  确认强制覆盖
                </button>
              </div>
            </div>
          ) : null}

          {cms.error ? <div className="banner err">{cms.error}</div> : null}

          <div className="editor-body" style={showForm ? undefined : { gridTemplateColumns: '1fr' }}>
            {showForm ? (
              <div className="form-col">
                <FrontmatterForm
                  schema={schema}
                  fields={cms.fields}
                  issues={formIssues}
                  covers={cms.covers}
                  onChange={cms.setField}
                />
              </div>
            ) : null}

            <div className="doc-col">
              <div className="tabs">
                {/* 编辑区布局三项与 settings.editorLayout 一一对应，点击即落盘 */}
                {EDITOR_LAYOUT_META.map((item) => (
                  <button
                    key={item.layout}
                    type="button"
                    title={item.hint}
                    className={`tab${!showDiff && cms.editorLayout === item.layout ? ' active' : ''}`}
                    onClick={() => {
                      setShowDiff(false)
                      void cms.setEditorLayout(item.layout)
                    }}
                  >
                    {item.label}
                  </button>
                ))}
                <span className="tabs-gap" />
                <button
                  type="button"
                  className={`tab${showDiff ? ' active' : ''}`}
                  onClick={() => setShowDiff((value) => !value)}
                >
                  差异预览
                </button>
                {cms.preview?.summary.frontmatterFormatOnly ? (
                  <span className="badge warn-badge">仅格式化差异</span>
                ) : null}
              </div>

              {/* 写作区：编辑器常驻挂载，靠 hidden 隐藏，撤销栈与光标不丢 */}
              <div className="write-area" data-layout={cms.editorLayout} hidden={showDiff}>
                <div className="editor-slot" hidden={cms.editorLayout === 'preview'}>
                  <MarkdownEditor value={cms.body} onChange={cms.setBody} />
                </div>
                <div
                  className="preview markdown-body"
                  hidden={cms.editorLayout === 'editor'}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              </div>

              {showDiff ? (
                <div className="diff-wrap">
                  {cms.preview ? (
                    <>
                      <div className="diff-summary">
                        +{cms.preview.summary.added} / -{cms.preview.summary.removed}；变更字段：
                        {cms.preview.changes.map((change) => change.key).join(' / ') || '（仅正文）'}
                        {cms.preview.skipped.length > 0
                          ? `；已跳过（语义未变）：${cms.preview.skipped.join(' / ')}`
                          : ''}
                      </div>
                      <DiffView lines={cms.preview.diff} />
                    </>
                  ) : (
                    <p className="hint">点击「查看差异」生成 dry-run 预览（不写盘）。</p>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <div className="empty">
          <h2>选择一个条目开始编辑</h2>
          <p className="hint">
            工作区：{cms.workspaceRoot || '未配置'}
            <br />
            {cms.status}
          </p>
          {formIssues.length > 0 ? (
            <div className="issues">
              {formIssues.slice(0, 12).map((issue, index) => (
                <div key={index} className={issue.level === 'block' ? 'fm-issue err' : 'fm-issue warn'}>
                  {issue.field ? `${issue.field}：` : ''}
                  {issue.message}
                </div>
              ))}
            </div>
          ) : null}
          {compact ? (
            <button type="button" className="ghost" onClick={onExitFocus}>
              退出专注写作
            </button>
          ) : null}
        </div>
      )}

      <footer className="status">{cms.status}</footer>
    </main>
  )
}