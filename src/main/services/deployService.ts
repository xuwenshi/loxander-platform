import { CmsError } from '../errors'

/**
 * 部署回读（P4）。
 *
 * 纯逻辑 + 注入式 HTTP：真正的网络实现放在 httpClient.ts（Electron net，原生支持 socks5 代理），
 * 这里只做「查 → 按 SHA 匹配 → 退避轮询 → HTTP 复核 → 归一状态」，因此可以完全用假 HTTP 做单测。
 *
 * 默认通道：GitHub commit status（公开仓库可零配置匿名读，60 次/小时）；
 * 增强通道：Vercel REST API（需只读 Token，能拿到部署直链与更细状态，按 meta.githubCommitSha 精确匹配 SHA）。
 */

export type DeployProvider = 'github' | 'vercel'

/** 归一后的部署状态：pending（排队）/ building（构建中）/ ready / error / unknown */
export type DeployState = 'pending' | 'building' | 'ready' | 'error' | 'unknown'

export interface HttpRequest {
  url: string
  method?: string
  headers?: Record<string, string>
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>

export interface DeployError {
  code: string
  message: string
}

export interface DeployStatus {
  provider: DeployProvider
  sha: string
  state: DeployState
  /** 提供方原始状态串（GitHub state / Vercel readyState），便于排查 */
  rawState: string
  /** 生产/预览地址（Vercel 可给出；GitHub status 仅能给出部署详情页） */
  url: string | null
  /** GitHub statuses 的 target_url（一般指向 Vercel 部署详情） */
  targetUrl: string | null
  /** Vercel 部署详情页 */
  inspectorUrl: string | null
  description: string | null
  message: string | null
  /** 已轮询次数 */
  attempts: number
  /** ready 时是否通过了生产地址的 HTTP 复核 */
  verified: boolean
  verifyStatus: number | null
  updatedAt: string
  error: DeployError | null
}

/** 单次查询所需的全部参数（UI 侧轮询时反复调用它） */
export interface DeployQueryOptions {
  provider: DeployProvider
  /** owner/repo */
  repository: string
  sha: string
  vercelToken?: string
  vercelProjectId?: string
  http: HttpClient
}

export interface DeployPollOptions extends DeployQueryOptions {
  /** ready 后做一次 HTTP 复核的目标（通常为生产域名；留空则跳过复核） */
  productionUrl?: string
  intervalMs?: number
  maxIntervalMs?: number
  maxAttempts?: number
  timeoutMs?: number
  /** 注入 sleep（测试可置为 no-op） */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const DEFAULT_INTERVAL = 5_000
const DEFAULT_MAX_INTERVAL = 15_000
const DEFAULT_MAX_ATTEMPTS = 24
const DEFAULT_TIMEOUT = 180_000

const GITHUB_API = 'https://api.github.com'
const VERCEL_API = 'https://api.vercel.com'

/** 从 git remote URL 解析 `owner/repo`（支持 https 与 ssh 两种写法） */
export function parseRepoSlug(input: string): string | null {
  const value = (input ?? '').trim().replace(/\.git$/, '')
  if (!value) return null
  const ssh = /^git@[^:]+:(.+)$/.exec(value)
  let path = ssh ? ssh[1] : ''
  if (!ssh) {
    try {
      path = new URL(value).pathname
    } catch {
      return null
    }
  }
  const parts = path.replace(/^\/+/, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  return `${parts[0]}/${parts[1]}`
}

function mapGithubState(state: string | undefined): DeployState {
  switch (state) {
    case 'success':
      return 'ready'
    case 'failure':
    case 'error':
      return 'error'
    case 'pending':
      return 'pending'
    default:
      return 'unknown'
  }
}

function mapVercelState(state: string | undefined): DeployState {
  switch (state) {
    case 'READY':
      return 'ready'
    case 'ERROR':
    case 'CANCELED':
      return 'error'
    case 'BUILDING':
    case 'INITIALIZING':
      return 'building'
    case 'QUEUED':
      return 'pending'
    default:
      return 'unknown'
  }
}

function pickLatest<T extends { updated_at?: string }>(items: T[]): T | undefined {
  return [...items].sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))[0]
}

function baseStatus(provider: DeployProvider, sha: string): DeployStatus {
  return {
    provider,
    sha,
    state: 'unknown',
    rawState: 'unknown',
    url: null,
    targetUrl: null,
    inspectorUrl: null,
    description: null,
    message: null,
    attempts: 0,
    verified: false,
    verifyStatus: null,
    updatedAt: new Date().toISOString(),
    error: null
  }
}

async function queryGithub(options: DeployQueryOptions): Promise<DeployStatus> {
  const res = await options.http({
    url: `${GITHUB_API}/repos/${options.repository}/commits/${options.sha}/status`,
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'electron-cms' }
  })
  if (res.status === 404) {
    throw new CmsError(
      'DEPLOY_NOT_FOUND',
      `GitHub 查不到提交 ${options.sha.slice(0, 8)} 的状态`,
      '确认仓库标识与 SHA；若为私有仓库需配置 Token'
    )
  }
  if (res.status === 403 || res.status === 429) {
    throw new CmsError('DEPLOY_HTTP', 'GitHub API 触发限流（匿名 60 次/小时）', '稍后重试，或改用 Vercel Token 通道')
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CmsError('DEPLOY_HTTP', `GitHub API 返回 ${res.status}`, undefined, { body: res.body.slice(0, 500) })
  }

  const data = JSON.parse(res.body) as {
    state?: string
    statuses?: Array<{ state?: string; target_url?: string | null; description?: string | null; updated_at?: string }>
  }
  const latest = pickLatest(data.statuses ?? [])
  return {
    ...baseStatus('github', options.sha),
    state: mapGithubState(data.state),
    rawState: data.state ?? 'unknown',
    targetUrl: latest?.target_url ?? null,
    description: latest?.description ?? null
  }
}

async function queryVercel(options: DeployQueryOptions): Promise<DeployStatus> {
  const params = new URLSearchParams({ limit: '20' })
  if (options.vercelProjectId) params.set('projectId', options.vercelProjectId)
  const res = await options.http({
    url: `${VERCEL_API}/v6/deployments?${params.toString()}`,
    headers: { accept: 'application/json', authorization: `Bearer ${options.vercelToken ?? ''}` }
  })
  if (res.status === 401 || res.status === 403) {
    throw new CmsError('DEPLOY_HTTP', 'Vercel Token 无效或权限不足', '需要只读 Token')
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CmsError('DEPLOY_HTTP', `Vercel API 返回 ${res.status}`, undefined, { body: res.body.slice(0, 500) })
  }

  const data = JSON.parse(res.body) as {
    deployments?: Array<{
      uid?: string
      url?: string
      readyState?: string
      state?: string
      inspectorUrl?: string
      meta?: Record<string, unknown>
    }>
  }
  const all = data.deployments ?? []
  // 严格按 SHA 匹配，避免拿到「最新一条」这种错的部署
  const match = all.find((item) => {
    const meta = item.meta ?? {}
    return meta.githubCommitSha === options.sha || meta.githubCommitRef === options.sha
  })
  if (!match) {
    return {
      ...baseStatus('vercel', options.sha),
      state: 'pending',
      rawState: 'NOT_FOUND',
      message: `Vercel 尚未出现该 commit 的部署（本次返回 ${all.length} 条记录）`
    }
  }
  const rawState = match.readyState ?? match.state ?? 'unknown'
  return {
    ...baseStatus('vercel', options.sha),
    state: mapVercelState(rawState),
    rawState,
    url: match.url ? `https://${match.url}` : null,
    inspectorUrl: match.inspectorUrl ?? null
  }
}

/** ready 后对生产地址做一次 HTTP 复核（避免「API 说 ready 但站点其实 5xx」） */
async function verifyProduction(
  url: string,
  http: HttpClient
): Promise<{ ok: boolean; status: number | null }> {
  const target = /^https?:\/\//.test(url) ? url : `https://${url}`
  try {
    const res = await http({ url: target, method: 'GET', headers: { accept: 'text/html' } })
    return { ok: res.status >= 200 && res.status < 400, status: res.status }
  } catch {
    return { ok: false, status: null }
  }
}

function assertConfig(options: DeployQueryOptions): void {
  if (!options.sha) {
    throw new CmsError('DEPLOY_CONFIG', '缺少 commit SHA', '先完成一次发布（pushed）再查询部署')
  }
  if (options.provider === 'github') {
    if (!/^[^/\s]+\/[^/\s]+$/.test(options.repository)) {
      throw new CmsError('DEPLOY_CONFIG', `仓库标识非法：${options.repository || '（空）'}`, '需要 owner/repo 形式')
    }
    return
  }
  if (!options.vercelToken) {
    throw new CmsError('DEPLOY_CONFIG', 'Vercel 通道需要 Token', '在 settings.json 配置 vercelToken（只读即可）')
  }
}

/**
 * 单次查询：查一次部署提供方并归一状态。不含轮询，供 UI 主动轮询（带进度反馈）。
 */
export async function queryDeploy(options: DeployQueryOptions): Promise<DeployStatus> {
  assertConfig(options)
  const result = options.provider === 'github' ? await queryGithub(options) : await queryVercel(options)
  return { ...result, updatedAt: new Date().toISOString() }
}

/**
 * 按 SHA 轮询部署状态直到就绪/失败/超时/次数用尽。
 * 退避：interval * 2^(n-1)，上限 maxInterval。
 */
export async function pollDeploy(options: DeployPollOptions): Promise<DeployStatus> {
  const interval = options.intervalMs ?? DEFAULT_INTERVAL
  const maxInterval = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  const started = now()

  let last: DeployStatus | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const queried = await queryDeploy(options)
    last = { ...queried, attempts: attempt }

    if (queried.state === 'ready' || queried.state === 'error') {
      if (queried.state === 'ready' && options.productionUrl) {
        const verified = await verifyProduction(options.productionUrl, options.http)
        last = {
          ...last,
          verified: verified.ok,
          verifyStatus: verified.status,
          message: verified.ok ? null : `生产地址复核未通过（HTTP ${verified.status ?? '无响应'}）`,
          error: verified.ok ? null : { code: 'DEPLOY_HTTP', message: '生产地址复核未通过' }
        }
      }
      return last
    }

    if (now() - started >= timeoutMs) {
      return { ...last, message: last.message ?? `轮询超时（${Math.round(timeoutMs / 1000)} 秒内未就绪）` }
    }

    const wait = Math.min(interval * 2 ** (attempt - 1), maxInterval)
    await sleep(wait)
  }

  return { ...(last ?? baseStatus(options.provider, options.sha)), message: last?.message ?? '轮询次数用尽仍未就绪' }
}