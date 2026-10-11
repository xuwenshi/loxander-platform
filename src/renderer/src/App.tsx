import { useEffect, useMemo, useState } from 'react'
import DiffView from './components/DiffView'
import FrontmatterForm from './components/FrontmatterForm'
import MarkdownEditor from './components/MarkdownEditor'
import PromptDialog from './components/PromptDialog'
import PublishPanel from './components/PublishPanel'
import { renderMarkdown } from './markdown'
import { useCms } from './store'

/**
 * P1 界面：内容列表 + schema 驱动的 frontmatter 表单 + Markdown 编辑/预览/差异。
 * P2 界面：发布闸门（预检报告 → 人工确认卡 → 提交并推送 → 发布状态机）。
 * 「保存」只发送被编辑字段的字段级 patch，未触碰字段由主进程保持逐字节不变。
 */

type DocTab = 'body' | 'preview' | 'diff'
type View = 'edit' | 'publish'
/** 需要输入文本的操作：Electron 不支持 window.prompt，改用应用内弹窗 */
type DialogKind = 'create' | 'rename'

export default function App() {
  const cms = useCms()
  const [tab, setTab] = useState<DocTab>('body')
  const [view, setView] = useState<View>('edit')
  const [dialog, setDialog] = useState<DialogKind | null>(null)

  useEffect(() => {
    void cms.bootstrap()
    // 只在首次挂载时初始化
  }, [])

  const current = cms.sections.find((item) => item.section === cms.activeSection)
  const schema = cms.schemas[cms.activeSection]
  const html = useMemo(() => (tab === 'preview' ? renderMarkdown(cms.body) : ''), [tab, cms.body])

  const formIssues = useMemo(
    () => [...cms.workspaceIssues.blocking, ...cms.workspaceIssues.warnings],
    [cms.workspaceIssues]
  )

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
    <div className={view === 'publish' ? 'layout publish-mode' : 'layout'}>
      <aside className="sidebar">
        <h1>内容分区</h1>
        {cms.sections.map((item) => (
          <div
            key={item.section}
            className={`tree-item${item.section === cms.activeSection && view === 'edit' ? ' active' : ''}`}
            onClick={() => {
              setView('edit')
              cms.selectSection(item.section)
            }}
          >
            <span>{item.section}</span>
            <span className="count">{item.count}</span>
          </div>
        ))}
        <div className="sidebar-foot">
          <button
            type="button"
            className={view === 'publish' ? 'primary block' : 'ghost block'}
            onClick={() => setView(view === 'publish' ? 'edit' : 'publish')}
          >
            {view === 'publish' ? '返回编辑' : '发布 / Git 闸门'}
          </button>
          <button type="button" className="ghost block" onClick={() => void cms.validateWorkspace()}>
            校验全仓
          </button>
          <button type="button" className="ghost block" onClick={() => void cms.refreshList()}>
            刷新清单
          </button>
          <button type="button" className="ghost block" onClick={() => void cms.pickWorkspace()}>
            选择工作区…
          </button>
          <div className="ws-path">{cms.workspaceRoot || '未配置工作区'}</div>
          {!cms.bridgeOk ? <div className="err tiny">preload 桥未就绪</div> : null}
        </div>
      </aside>

      {view === 'publish' ? (
        <PublishPanel onBack={() => setView('edit')} />
      ) : (
        <>
          <section className="entries">
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
              <div className="entry-title">{entry.title ?? <span className="badge err-badge">缺 title</span>}</div>
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

      <main className="editor-pane">
        {cms.doc && schema ? (
          <>
            <header className="doc-head">
              <div className="doc-title">
                {String(cms.fields.title ?? cms.fields.name ?? cms.activeSlug)}
                <span className="path">{cms.doc.file}</span>
              </div>
              <div className="doc-actions">
                <span className={cms.isDirty() ? 'dirty on' : 'dirty'}>
                  {cms.isDirty() ? '有未保存改动' : '已同步'}
                </span>
                <button type="button" className="ghost" onClick={() => void cms.runPreview()}>
                  查看差异
                </button>
                <button type="button" className="ghost" onClick={handleRename}>
                  重命名
                </button>
                <button type="button" className="ghost danger-ghost" onClick={handleDelete}>
                  删除
                </button>
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

            <div className="editor-body">
              <div className="form-col">
                <FrontmatterForm
                  schema={schema}
                  fields={cms.fields}
                  issues={formIssues}
                  covers={cms.covers}
                  onChange={cms.setField}
                />
              </div>

              <div className="doc-col">
                <div className="tabs">
                  {(['body', 'preview', 'diff'] as DocTab[]).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={`tab${tab === item ? ' active' : ''}`}
                      onClick={() => setTab(item)}
                    >
                      {item === 'body' ? '正文' : item === 'preview' ? '预览（消毒）' : '差异预览'}
                    </button>
                  ))}
                  {cms.preview?.summary.frontmatterFormatOnly ? (
                    <span className="badge warn-badge">仅格式化差异</span>
                  ) : null}
                </div>

                {tab === 'body' ? (
                  <MarkdownEditor value={cms.body} onChange={cms.setBody} />
                ) : null}
                {tab === 'preview' ? (
                  <div className="preview markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
                ) : null}
                {tab === 'diff' ? (
                  <div className="diff-wrap">
                    {cms.preview ? (
                      <>
                        <div className="diff-summary">
                          +{cms.preview.summary.added} / -{cms.preview.summary.removed}；变更字段：
                          {cms.preview.changes.map((change) => change.key).join(' / ') || '（仅正文）'}
                          {cms.preview.skipped.length > 0 ? `；已跳过（语义未变）：${cms.preview.skipped.join(' / ')}` : ''}
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
            {cms.workspaceIssues.blocking.length + cms.workspaceIssues.warnings.length > 0 ? (
              <div className="issues">
                {formIssues.slice(0, 12).map((issue, index) => (
                  <div key={index} className={issue.level === 'block' ? 'fm-issue err' : 'fm-issue warn'}>
                    {issue.field ? `${issue.field}：` : ''}
                    {issue.message}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}

        <footer className="status">{cms.status}</footer>
          </main>
        </>
      )}

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