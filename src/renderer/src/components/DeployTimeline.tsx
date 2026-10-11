import { deployStateLabel, useCms } from '../store'
import type { DeployProvider, DeployState } from '../../../preload/api'

/**
 * 部署回读面板（P4）：
 * 发布（pushed）后，按 commit SHA 回读部署状态。
 * - GitHub commit status：零配置（公开仓库匿名可读），只能给出合成状态与部署详情页；
 * - Vercel API：需只读 Token，可给出部署直链与更细状态，并严格按 SHA 匹配；
 * - 「等待就绪」= 主进程退避轮询到就绪/失败/超时；「快速查询」= 只查一次。
 */

function stateClass(state: DeployState): string {
  if (state === 'ready') return 'badge ok-badge'
  if (state === 'error') return 'badge err-badge'
  if (state === 'pending' || state === 'building') return 'badge warn-badge'
  return 'badge'
}

export default function DeployTimeline() {
  const cms = useCms()
  const status = cms.deployStatus
  const sha = cms.publishState?.commitSha ?? ''
  const disabled = cms.deploying || sha.length === 0

  return (
    <section className="deploy-panel">
      <div className="deploy-head">
        <h3>部署回读</h3>
        <div className="deploy-controls">
          <select
            value={cms.deployProvider}
            onChange={(event) => cms.setDeployProvider(event.target.value as DeployProvider)}
          >
            <option value="github">GitHub commit status（零配置）</option>
            <option value="vercel">Vercel API（需只读 Token）</option>
          </select>
          <span className="hint mono">{sha ? sha.slice(0, 10) : '尚无已推送提交'}</span>
          <button type="button" className="primary" onClick={() => void cms.runDeployStatus(true)} disabled={disabled}>
            {cms.deploying ? '查询中…' : '查询部署（等待就绪）'}
          </button>
          <button type="button" className="ghost" onClick={() => void cms.runDeployStatus(false)} disabled={disabled}>
            快速查询
          </button>
          {status ? (
            <button type="button" className="ghost" onClick={cms.clearDeployStatus} disabled={cms.deploying}>
              清除
            </button>
          ) : null}
        </div>
      </div>

      {sha.length === 0 ? (
        <p className="hint">先完成一次「提交并推送」，这里才能按 SHA 回读部署状态。</p>
      ) : null}

      {status ? (
        <div className="deploy-status">
          <div className="deploy-status-row">
            <span className={stateClass(status.state)}>{deployStateLabel(status.state)}</span>
            <span className="mono tiny">{status.provider} · {status.rawState}</span>
            <span className="hint tiny">查询 {status.attempts || 1} 次</span>
            {status.verified ? <span className="badge ok-badge">生产地址复核通过（HTTP {status.verifyStatus}）</span> : null}
            {!status.verified && status.verifyStatus !== null ? (
              <span className="badge err-badge">生产地址复核未通过（HTTP {status.verifyStatus}）</span>
            ) : null}
          </div>

          {status.url ? (
            <div className="tiny">
              部署直链：
              <a href={status.url} target="_blank" rel="noreferrer">
                {status.url}
              </a>
            </div>
          ) : null}
          {status.targetUrl ? (
            <div className="tiny">
              部署详情：
              <a href={status.targetUrl} target="_blank" rel="noreferrer">
                {status.targetUrl}
              </a>
            </div>
          ) : null}
          {status.inspectorUrl ? (
            <div className="tiny">
              Inspector：
              <a href={status.inspectorUrl} target="_blank" rel="noreferrer">
                {status.inspectorUrl}
              </a>
            </div>
          ) : null}
          {status.description ? <div className="hint tiny">{status.description}</div> : null}
          {status.message ? <div className="hint tiny">{status.message}</div> : null}
          {status.error ? (
            <div className="hint tiny err">
              {status.error.code}：{status.error.message}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}