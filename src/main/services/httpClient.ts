import { net, session, type Session } from 'electron'
import type { HttpClient, HttpRequest, HttpResponse } from './deployService'

/**
 * 真实 HTTP 客户端（P4）：用 Electron 原生 `net` + 独立 session 设置代理。
 *
 * 为什么不用 socks-proxy-agent：它 v10 起是 **ESM-only**，而主进程产物是 CJS，
 * `require` 存在 ERR_REQUIRE_ESM 风险。Electron 的 `net` 原生支持 socks5 代理，
 * 且与应用默认会话隔离，既安全又零额外依赖。
 */

/** 与默认会话隔离的专用分区：不落盘、不带 Cookie，避免污染应用会话 */
const PARTITION = 'cms-deploy'

/** 单请求超时，避免网络挂死时 IPC 永不返回 */
const REQUEST_TIMEOUT = 20_000

/** 把用户填写的代理归一为 Electron proxyRules；空值 = 直连 */
export function toProxyRules(proxy: string): string {
  const value = (proxy ?? '').trim()
  if (!value) return 'direct://'
  // 已带协议（socks5:// / socks5h:// / http:// / https://）直接透传；缺协议时按 socks5 处理
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `socks5://${value}`
}

interface CachedSession {
  rules: string
  session: Session
  ready: Promise<void>
}

let cached: CachedSession | null = null

/** 取得（并缓存）已设置好代理的专用 session；代理变更时重建 */
async function sessionFor(proxy: string): Promise<Session> {
  const rules = toProxyRules(proxy)
  if (cached && cached.rules === rules) {
    await cached.ready
    return cached.session
  }
  const ses = session.fromPartition(PARTITION)
  const ready = ses.setProxy({ proxyRules: rules })
  cached = { rules, session: ses, ready }
  await ready
  return ses
}

function normalizeHeaders(headers: Record<string, string[] | string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

function perform(ses: Session, request: HttpRequest): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const req = net.request({
      url: request.url,
      method: request.method ?? 'GET',
      redirect: 'follow',
      session: ses,
      useSessionCookies: false
    })

    for (const [key, value] of Object.entries(request.headers ?? {})) {
      req.setHeader(key, value)
    }

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      req.abort()
      reject(new Error(`请求超时（${REQUEST_TIMEOUT}ms）：${request.url}`))
    }, REQUEST_TIMEOUT)

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    req.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () =>
        finish(() =>
          resolve({
            status: response.statusCode,
            headers: normalizeHeaders(response.headers),
            body: Buffer.concat(chunks).toString('utf8')
          })
        )
      )
      response.on('error', (err: Error) => finish(() => reject(err)))
    })
    req.on('error', (err: Error) => finish(() => reject(err)))
    req.end()
  })
}

/** 构造一个绑定到指定代理的 HttpClient（deployService 的唯一网络依赖） */
export function createHttpClient(proxy: string): HttpClient {
  return async (request) => {
    const ses = await sessionFor(proxy)
    return perform(ses, request)
  }
}