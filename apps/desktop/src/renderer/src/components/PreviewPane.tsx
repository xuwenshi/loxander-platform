import { useEffect, useRef, useState } from 'react'
import type { WebviewElement } from '../webview'
import { useCms } from '../store'

/**
 * 本地实时预览面板（A 方案）：用 Electron <webview> 承载真实的博客页面。
 *
 * 安全：webview 使用独立 partition（persist:cms-preview），绕开主进程对 defaultSession
 * 的 CSP 覆写与 127.0.0.1 导航拦截；preload 剥离、Node 关闭、src 白名单在 main 的
 * will-attach-webview 里完成（渲染进程只负责挂载）。
 *
 * 刷新：store.previewReloadToken 每次自增（保存 / content/ 变化）后调用
 * reloadIgnoringCache()（等价 Cache-Control: no-cache）——实测普通 reload 对 .md 改动会
 * 持续陈旧，只有 no-cache 才秒级可见；仍陈旧时用「重启 dev server」兜底。
 *
 * 关键约束（踩过的坑）：webview 的方法在「挂到 DOM 且 dom-ready 已触发」之前调用会**直接抛异常**，
 * 异常一旦冒泡就会卸载整棵 React 树 → 整个窗口变白。所以这里所有 webview 方法调用都必须
 * ①等 dom-ready ②包 try/catch。
 */
export default function PreviewPane({ hidden }: { hidden: boolean }) {
  const cms = useCms()
  const frameRef = useRef<WebviewElement | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  /** webview 是否已 dom-ready：未就绪时禁止调用其方法 */
  const [frameReady, setFrameReady] = useState(false)

  const status = cms.previewStatus
  const origin = status.origin
  const ready = status.state === 'ready' && Boolean(origin)
  /** 就绪后主进程会主动 GET 一次 origin：false 表示进程在监听但页面打不开（编译错误 / 500） */
  const probeFailed = ready && status.verified === false
  /** 未配置工作区时主进程会直接给出 error 态，这里据此展示明确的修复指引 */
  const noWorkspace = !cms.workspaceRoot

  /** 用 no-cache 重载一次；webview 未 dom-ready / guest 已崩时调用会抛异常，一律吞掉 */
  const softReload = (): void => {
    try {
      frameRef.current?.reloadIgnoringCache()
    } catch {
      /* 尚未 attach 或未 dom-ready：忽略，下次内容变更仍会重试 */
    }
  }

  // 追踪 webview 生命周期：dom-ready 之后才允许调用方法；重新导航（如重启后换端口）时复位
  useEffect(() => {
    const el = frameRef.current
    if (!ready || !el) {
      setFrameReady(false)
      return
    }
    const onDomReady = (): void => setFrameReady(true)
    const onStartLoading = (): void => setFrameReady(false)
    el.addEventListener('dom-ready', onDomReady)
    el.addEventListener('did-start-loading', onStartLoading)
    return () => {
      el.removeEventListener('dom-ready', onDomReady)
      el.removeEventListener('did-start-loading', onStartLoading)
    }
  }, [ready, origin])

  /** 已应用过的 reloadToken：避免首次挂载就重载（webview 本来就是新加载的） */
  const appliedToken = useRef(cms.previewReloadToken)
  useEffect(() => {
    if (!frameReady) return
    if (cms.previewReloadToken === appliedToken.current) return
    appliedToken.current = cms.previewReloadToken
    softReload()
  }, [cms.previewReloadToken, frameReady])

  // 打开日志抽屉时补拉一次，避免打开是空的
  useEffect(() => {
    if (showLogs) void cms.refreshPreviewLogs()
  }, [showLogs])

  return (
    <section className="preview-pane" hidden={hidden}>
      <header className="preview-head">
        <span className="title">
          网站预览
          {origin ? <span className="origin">{origin}</span> : null}
          {/*
            健康探测徽标：就绪 ≠ 页面能打开。探测失败时进程仍在跑（可能是编译报错），
            所以这里只做标注，不阻止 webview 渲染——用户仍能看到 Next 自己的错误页。
          */}
          {probeFailed ? (
            <span className="tiny" style={{ color: 'var(--err, #f87171)' }}>
              页面无响应
              {status.verifyStatus === null ? '' : `（HTTP ${status.verifyStatus}）`}
            </span>
          ) : null}
        </span>
        <span className="preview-actions">
          {ready ? (
            <button
              type="button"
              className="ghost tiny"
              title="用 no-cache 重载一次（内容已保存时可强制取新）"
              onClick={softReload}
            >
              刷新
            </button>
          ) : null}
          {status.state === 'starting' ? (
            <button type="button" className="ghost tiny" disabled>
              启动中…
            </button>
          ) : status.state === 'ready' ? (
            <button type="button" className="ghost tiny" onClick={() => void cms.stopPreview()}>
              停止
            </button>
          ) : (
            <button type="button" className="ghost tiny" onClick={() => void cms.startPreview()}>
              启动预览
            </button>
          )}
          {status.state === 'ready' || status.state === 'error' ? (
            <button type="button" className="ghost tiny" onClick={() => void cms.restartPreview()}>
              重启
            </button>
          ) : null}
          <button type="button" className="ghost tiny" onClick={() => setShowLogs((value) => !value)}>
            {showLogs ? '隐藏日志' : '查看日志'}
          </button>
          <button type="button" className="ghost tiny" onClick={cms.closePreview} title="收起预览列">
            收起
          </button>
        </span>
      </header>

      <div className="preview-body">
        {ready ? (
          // partition 必须构建时确定且之后不改；src 变化（如重启后换端口）会让 webview 重新导航
          <webview
            ref={frameRef}
            className="preview-frame"
            src={origin ?? ''}
            partition="persist:cms-preview"
          />
        ) : (
          <div className="preview-placeholder">
            {noWorkspace ? (
              <>
                <p className="err">尚未配置内容工作区</p>
                <p className="hint">
                  本地预览需要一个 my-blog 仓库根目录才能拉起 next dev。
                  <br />
                  点左下角「选择工作区…」指定仓库后，预览会自动重启。
                </p>
              </>
            ) : status.state === 'starting' ? (
              <p className="hint">正在启动本地预览（首次编译可能需要十几秒）…</p>
            ) : status.state === 'error' ? (
              <>
                <p className="err">预览启动失败</p>
                <p className="hint">{status.message ?? '请点「查看日志」了解详情'}</p>
              </>
            ) : (
              <p className="hint">
                本地预览会在本机拉起一个 next dev，把真实博客页面嵌进来。
                <br />
                保存内容后自动刷新（秒级可见）。
              </p>
            )}
          </div>
        )}

        {showLogs ? <pre className="preview-logs">{cms.previewLogs || '（暂无日志）'}</pre> : null}
      </div>
    </section>
  )
}
