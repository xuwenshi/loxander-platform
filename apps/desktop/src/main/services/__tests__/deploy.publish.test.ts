import { describe, expect, it } from 'vitest'
import {
  parseRepoSlug,
  pollDeploy,
  queryDeploy,
  type HttpClient,
  type HttpResponse
} from '../deployService'

/**
 * P4 门禁：部署回读用**假 HTTP**做单测，不触网。
 * 覆盖：SHA 精确匹配、状态归一、退避序列、超时、生产地址 HTTP 复核、配置缺失。
 */

function res(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: {},
    body: typeof body === 'string' ? body : JSON.stringify(body)
  }
}

/** GitHub commit status 响应样例 */
const GH_PENDING = { state: 'pending', statuses: [] }
const GH_SUCCESS = {
  state: 'success',
  statuses: [
    {
      state: 'success',
      target_url: 'https://vercel.com/xuwenshi/blog/abc',
      description: 'Deployment has completed',
      updated_at: '2026-01-01T00:00:00Z'
    }
  ]
}

const noSleep = async (): Promise<void> => undefined

describe('parseRepoSlug', () => {
  it('解析 https 与 ssh 两种 remote', () => {
    expect(parseRepoSlug('https://github.com/xuwenshi/blog.git')).toBe('xuwenshi/blog')
    expect(parseRepoSlug('https://github.com/xuwenshi/blog')).toBe('xuwenshi/blog')
    expect(parseRepoSlug('git@github.com:xuwenshi/blog.git')).toBe('xuwenshi/blog')
  })

  it('无法解析时返回 null', () => {
    expect(parseRepoSlug('')).toBeNull()
    expect(parseRepoSlug('not-a-url')).toBeNull()
    expect(parseRepoSlug('https://github.com/onlyowner')).toBeNull()
  })
})

describe('配置校验（零网络副作用）', () => {
  const http: HttpClient = async () => res(200, GH_PENDING)

  it('缺少 SHA → DEPLOY_CONFIG', async () => {
    await expect(
      queryDeploy({ provider: 'github', repository: 'a/b', sha: '', http })
    ).rejects.toMatchObject({ code: 'DEPLOY_CONFIG' })
  })

  it('GitHub 仓库标识非法 → DEPLOY_CONFIG', async () => {
    await expect(
      queryDeploy({ provider: 'github', repository: '', sha: 'abc', http })
    ).rejects.toMatchObject({ code: 'DEPLOY_CONFIG' })
  })

  it('Vercel 缺少 Token → DEPLOY_CONFIG', async () => {
    await expect(
      queryDeploy({ provider: 'vercel', repository: 'a/b', sha: 'abc', http })
    ).rejects.toMatchObject({ code: 'DEPLOY_CONFIG' })
  })
})

describe('GitHub commit status 通道', () => {
  it('404 → DEPLOY_NOT_FOUND', async () => {
    const http: HttpClient = async () => res(404, { message: 'Not Found' })
    await expect(
      queryDeploy({ provider: 'github', repository: 'a/b', sha: 'deadbeef', http })
    ).rejects.toMatchObject({ code: 'DEPLOY_NOT_FOUND' })
  })

  it('403 → DEPLOY_HTTP（限流提示）', async () => {
    const http: HttpClient = async () => res(403, { message: 'rate limited' })
    await expect(
      queryDeploy({ provider: 'github', repository: 'a/b', sha: 'deadbeef', http })
    ).rejects.toMatchObject({ code: 'DEPLOY_HTTP' })
  })

  it('pending → success：轮询 2 次后 ready，并带 target_url', async () => {
    let call = 0
    const http: HttpClient = async () => {
      call += 1
      return res(200, call === 1 ? GH_PENDING : GH_SUCCESS)
    }
    const status = await pollDeploy({
      provider: 'github',
      repository: 'xuwenshi/blog',
      sha: 'abc1234',
      http,
      sleep: noSleep,
      intervalMs: 1000
    })

    expect(status.state).toBe('ready')
    expect(status.rawState).toBe('success')
    expect(status.attempts).toBe(2)
    expect(status.targetUrl).toBe('https://vercel.com/xuwenshi/blog/abc')
    expect(status.sha).toBe('abc1234')
  })

  it('退避序列为 interval * 2^(n-1)，并受 maxInterval 约束', async () => {
    const waits: number[] = []
    const http: HttpClient = async () => res(200, GH_PENDING)
    await pollDeploy({
      provider: 'github',
      repository: 'a/b',
      sha: 's',
      http,
      intervalMs: 1000,
      maxIntervalMs: 3000,
      maxAttempts: 5,
      sleep: async (ms) => {
        waits.push(ms)
      }
    })
    expect(waits).toEqual([1000, 2000, 3000, 3000, 3000])
  })

  it('超时后返回最后一次状态并给出提示', async () => {
    let clock = 0
    const http: HttpClient = async () => res(200, GH_PENDING)
    const status = await pollDeploy({
      provider: 'github',
      repository: 'a/b',
      sha: 's',
      http,
      sleep: noSleep,
      now: () => (clock += 1000),
      timeoutMs: 1000
    })
    expect(status.state).toBe('pending')
    expect(status.message).toContain('超时')
  })
})

describe('Vercel 通道：按 SHA 精确匹配', () => {
  it('无匹配 SHA → pending / NOT_FOUND（绝不误用「最新一条」）', async () => {
    const http: HttpClient = async () =>
      res(200, {
        deployments: [
          { uid: '1', url: 'other.vercel.app', readyState: 'READY', meta: { githubCommitSha: 'someone-else' } }
        ]
      })
    const status = await queryDeploy({
      provider: 'vercel',
      repository: 'a/b',
      sha: 'mine',
      vercelToken: 'tok',
      http
    })
    expect(status.state).toBe('pending')
    expect(status.rawState).toBe('NOT_FOUND')
    expect(status.url).toBeNull()
    expect(status.message).toContain('尚未出现')
  })

  it('命中 SHA → ready，并给出部署直链与详情页', async () => {
    const http: HttpClient = async () =>
      res(200, {
        deployments: [
          { uid: '0', url: 'old.vercel.app', readyState: 'READY', meta: { githubCommitSha: 'old-sha' } },
          {
            uid: '2',
            url: 'my-blog.vercel.app',
            readyState: 'READY',
            inspectorUrl: 'https://vercel.com/xuwenshi/my-blog/2',
            meta: { githubCommitSha: 'mine' }
          }
        ]
      })
    const status = await queryDeploy({
      provider: 'vercel',
      repository: 'a/b',
      sha: 'mine',
      vercelToken: 'tok',
      http
    })
    expect(status.state).toBe('ready')
    expect(status.url).toBe('https://my-blog.vercel.app')
    expect(status.inspectorUrl).toBe('https://vercel.com/xuwenshi/my-blog/2')
  })

  it('BUILDING → building（归一状态）', async () => {
    const http: HttpClient = async () =>
      res(200, {
        deployments: [{ url: 'x.vercel.app', readyState: 'BUILDING', meta: { githubCommitSha: 'mine' } }]
      })
    const status = await queryDeploy({
      provider: 'vercel',
      repository: 'a/b',
      sha: 'mine',
      vercelToken: 'tok',
      http
    })
    expect(status.state).toBe('building')
  })
})

describe('生产地址 HTTP 复核（API 说 ready ≠ 站点可用）', () => {
  const url = 'https://my-blog.vercel.app'

  it('复核失败：verified=false 且写入错误', async () => {
    const http: HttpClient = async (request) => {
      if (request.url.includes('/commits/')) return res(200, GH_SUCCESS)
      return res(500, 'boom')
    }
    const status = await pollDeploy({
      provider: 'github',
      repository: 'a/b',
      sha: 's',
      productionUrl: url,
      http,
      sleep: noSleep
    })
    expect(status.state).toBe('ready')
    expect(status.verified).toBe(false)
    expect(status.verifyStatus).toBe(500)
    expect(status.error?.code).toBe('DEPLOY_HTTP')
  })

  it('复核通过：verified=true，无错误', async () => {
    const http: HttpClient = async (request) => {
      if (request.url.includes('/commits/')) return res(200, GH_SUCCESS)
      return res(200, '<html>ok</html>')
    }
    const status = await pollDeploy({
      provider: 'github',
      repository: 'a/b',
      sha: 's',
      productionUrl: url,
      http,
      sleep: noSleep
    })
    expect(status.verified).toBe(true)
    expect(status.verifyStatus).toBe(200)
    expect(status.error).toBeNull()
    expect(status.message).toBeNull()
  })
})