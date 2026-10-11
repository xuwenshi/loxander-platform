import { useEffect } from 'react'
import DeployTimeline from './DeployTimeline'
import { useCms } from '../store'

/**
 * 发布闸门面板（P2 + P4 + P5 可选回滚）：
 * 预检报告 → 变更文件清单（逐个勾选）→ commit message → 「我已确认」→ 提交并推送 → 状态机
 * → 部署回读（按 SHA 查询 GitHub commit status / Vercel API）→ 一键回滚（git revert，不改写历史）。
 * 预检未全绿时「提交并推送」不可用；取消/未确认不会产生任何提交或推送。
 */

function levelClass(level: 'block' | 'warn' | 'info'): string {
  return level === 'block' ? 'fm-issue err' : level === 'warn' ? 'fm-issue warn' : 'fm-issue info'
}

function stateBadge(phase: string, pushed: boolean): { text: string; className: string } {
  if (phase === 'pushed') return { text: '已推送远端', className: 'badge ok-badge' }
  if (phase === 'committed-not-pushed') return { text: '已提交 · 未推送', className: 'badge warn-badge' }
  return { text: '无待发布提交', className: 'badge' }
}

export default function PublishPanel({ onBack }: { onBack: () => void }) {
  const cms = useCms()

  useEffect(() => {
    void cms.runPreflight()
    // 进入面板即刷新一次预检与发布状态
  }, [])

  const report = cms.report
  const git = cms.gitStatus
  const state = cms.publishState
  const canSubmit =
    Boolean(report?.ok) &&
    cms.publishConfirmed &&
    cms.publishFiles.length > 0 &&
    cms.publishMessage.trim().length > 0 &&
    !cms.publishing

  return (
    <main className="publish-pane">
      <header className="doc-head">
        <div className="doc-title">
          发布闸门
          <span className="path">
            {git?.isRepo
              ? `${git.branch || '(detached)'} @ ${report?.remote ?? 'origin'}　ahead ${git.ahead} / behind ${git.behind}`
              : '工作区不是 Git 仓库'}
          </span>
        </div>
        <div className="doc-actions">
          <button type="button" className="ghost" onClick={onBack}>
            返回编辑
          </button>
          <button type="button" className="ghost" onClick={() => void cms.gitPull()} disabled={cms.publishing}>
            拉取（--ff-only）
          </button>
          <button type="button" className="primary" onClick={() => void cms.runPreflight()} disabled={cms.publishing}>
            {cms.publishing ? '处理中…' : '重新预检'}
          </button>
        </div>
      </header>

      {state ? (
        <div className={`banner ${state.phase === 'pushed' ? 'ok' : state.error ? 'err' : ''}`}>
          <div>
            <span className={stateBadge(state.phase, state.pushed).className}>
              {stateBadge(state.phase, state.pushed).text}
            </span>
            {state.commitSha ? <span className="mono"> {state.commitSha.slice(0, 10)}</span> : null}
            {state.message ? <span className="hint">　{state.message}</span> : null}
            {state.error ? (
              <div className="hint">
                {state.error.code}：{state.error.message}
                {state.error.hint ? `（${state.error.hint}）` : ''}
              </div>
            ) : null}
          </div>
          <div className="banner-actions">
            {state.phase === 'committed-not-pushed' ? (
              <button type="button" className="primary" onClick={() => void cms.retryPublish()} disabled={cms.publishing}>
                重试推送
              </button>
            ) : null}
            {state.commitSha ? (
              <button
                type="button"
                className="ghost"
                onClick={() => void cms.rollbackPublish()}
                disabled={cms.publishing}
              >
                回滚本次发布
              </button>
            ) : null}
            {state.phase !== 'idle' ? (
              <button type="button" className="ghost" onClick={() => void cms.resetPublish()} disabled={cms.publishing}>
                清除状态
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {cms.error ? <div className="banner err">{cms.error}</div> : null}

      {state ? <DeployTimeline /> : null}

      <div className="publish-body">
        <section className="publish-col">
          <h3>预检报告</h3>
          {report ? (
            <>
              <div className={`preflight-head ${report.ok ? 'ok' : 'err'}`}>
                {report.ok ? '预检通过：可以进入人工确认' : `预检未通过：${report.blocking.length} 项阻断`}
                <span className="hint">
                  　生成于 {new Date(report.generatedAt).toLocaleTimeString()}
                </span>
              </div>

              {report.blocking.length + report.warnings.length + report.infos.length === 0 ? (
                <p className="hint">没有发现任何问题。</p>
              ) : null}

              {[...report.blocking, ...report.warnings, ...report.infos].map((issue, index) => (
                <div key={`${issue.code}-${index}`} className={levelClass(issue.level)}>
                  <span className="mono">{issue.code}</span> {issue.message}
                  {issue.hint ? <div className="hint">{issue.hint}</div> : null}
                </div>
              ))}

              <div className="section-counts">
                分区篇数：
                {Object.entries(report.sectionCounts).map(([section, count]) => (
                  <span key={section} className="badge">
                    {section} {count}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="hint">尚未运行预检。</p>
          )}
        </section>

        <section className="publish-col">
          <h3>变更文件清单（逐项确认）</h3>
          {report && report.changedFiles.length > 0 ? (
            <div className="file-list">
              {report.changedFiles.map((file) => (
                <label key={file.path} className="file-item">
                  <input
                    type="checkbox"
                    checked={cms.publishFiles.includes(file.path)}
                    onChange={() => cms.togglePublishFile(file.path)}
                  />
                  <span className={`mono${file.isContent ? '' : ' other'}`}>{file.path}</span>
                  <span className="file-flags">
                    {file.untracked ? '新增' : file.index.trim() !== '' || file.workingDir.trim() !== '' ? '修改' : ''}
                    {file.isContent ? '' : '　非内容改动'}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="hint">没有待发布的变更文件。先在编辑页保存内容改动，再回到这里发布。</p>
          )}

          <h3>发布说明（commit message）</h3>
          <input
            className="publish-message"
            type="text"
            value={cms.publishMessage}
            placeholder="例如：content: 更新 blog/hello"
            onChange={(event) => cms.setPublishMessage(event.target.value)}
          />

          <label className="confirm-row">
            <input
              type="checkbox"
              checked={cms.publishConfirmed}
              onChange={(event) => cms.setPublishConfirmed(event.target.checked)}
            />
            <span>我已确认以上变更文件清单，同意提交并推送到远端</span>
          </label>

          <div className="publish-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void cms.runPublish()}
              disabled={!canSubmit}
            >
              {cms.publishing ? '发布中…' : '提交并推送'}
            </button>
            <span className="hint">
              已勾选 {cms.publishFiles.length} / {report?.changedFiles.length ?? 0} 个文件
            </span>
          </div>
        </section>
      </div>

      <footer className="status">{cms.status}</footer>
    </main>
  )
}