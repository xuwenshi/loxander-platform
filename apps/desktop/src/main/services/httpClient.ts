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

function perform(ses: Session, request: HttpRequest, timeoutMs = REQUEST_TIMEOUT): Promise<HttpResponse> {
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
      reject(new Error(`请求超时（${timeoutMs}ms）：${request.url}`))
    }, timeoutMs)

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

/* ---- 本地预览健康探测 ---- */

/**
 * 直连专用分区：**绝不能**复用 createHttpClient —— 它会把请求交给
 * socks5 代理，而代理不认 localhost，探测必然失败并把正常的预览误判成故障。
 */
const LOCAL_PARTITION = 'cms-local-probe'

let localSession: Session | null = null

async function localDirectSession(): Promise<Session> {
  if (localSession) return localSession
  const ses = session.fromPartition(LOCAL_PARTITION)
  // 显式直连：即使系统/应用层配了代理，本机探测也走直连
  await ses.setProxy({ proxyRules: 'direct://' })
  localSession = ses
  return ses
}

/** 探测结果：ok 为 2xx/3xx 才算页面真的能打开 */
export interface ProbeResult {
  ok: boolean
  status: number | null
}

/**
 * 本地探测专用超时：必须比线上请求宽松得多。
 * Next 打印 `Ready` 时只是「HTTP 服务已监听」，**首次请求才会触发整页编译**
 * （Cache Components 全量 SSR 可达十几秒）。用默认 20s 会在冷启动时误报「页面无响应」。
 */
const PROBE_TIMEOUT = 60_000

/**
 * 生成一个「直连探测本机预览」的函数，注入给 devServerService（保持其不 import electron）。
 * 只用于 localhost/127.0.0.1，不会用于线上地址。
 */
export function createLocalProbe(): (origin: string) => Promise<ProbeResult> {
  return async (origin: string): Promise<ProbeResult> => {
    try {
      const ses = await localDirectSession()
      const res = await perform(
        ses,
        { url: origin, method: 'GET', headers: { accept: 'text/html' } },
        PROBE_TIMEOUT
      )
      return { ok: res.status >= 200 && res.status < 400, status: res.status }
    } catch {
      return { ok: false, status: null }
    }
  }
}