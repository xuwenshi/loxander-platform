import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDevServer,
  parseDevServerUrl,
  pickPort,
  stripAnsi
} from '../devServerService'

/**
 * 本地预览 dev server 的门禁：只测纯函数与「无需真正 spawn」的分支
 * （ANSI 去色 / URL 解析 / 端口探测 / bin 缺失 / stop 幂等），
 * 不去真的拉起 next dev（那会依赖仓库与网络，测试会不稳）。
 */

describe('stripAnsi：去掉 Next 日志里的 ANSI 色码', () => {
  it('移除常见色码，保留正文', () => {
    expect(stripAnsi('\u001B[32m✓\u001B[0m Ready in 1.2s')).toBe('✓ Ready in 1.2s')
  })

  it('无 ANSI 时原样返回', () => {
    expect(stripAnsi('- Local: http://localhost:3210')).toBe('- Local: http://localhost:3210')
  })
})

describe('parseDevServerUrl：从 stdout 解析真实 origin 与端口', () => {
  it('从 Local 行取 origin 与端口', () => {
    expect(parseDevServerUrl('  - Local:        http://localhost:3210')).toEqual({
      origin: 'http://localhost:3210',
      port: 3210
    })
  })

  it('带 ANSI 色码也能解析', () => {
    expect(parseDevServerUrl('\u001B[36m- Local:\u001B[0m http://127.0.0.1:4210')).toEqual({
      origin: 'http://127.0.0.1:4210',
      port: 4210
    })
  })

  it('只有端口自增提示时给出自增后的端口', () => {
    expect(parseDevServerUrl('Port 3210 is in use, trying 3211 instead')).toEqual({
      origin: null,
      port: 3211
    })
  })

  it('无任何线索时返回空', () => {
    expect(parseDevServerUrl('▲ Next.js 16.0.0')).toEqual({ origin: null, port: null })
  })
})

describe('pickPort：空闲端口探测', () => {
  it('首选端口被占用则递增', () => {
    expect(pickPort(3210, [3210, 3211])).toBe(3212)
  })

  it('首选端口空闲则原样返回', () => {
    expect(pickPort(3210, [])).toBe(3210)
    expect(pickPort(3210, [3211])).toBe(3210)
  })
})

describe('createDevServer：无需真正 spawn 的分支', () => {
  it('Next 可执行文件缺失时报 error 且信息含路径', async () => {
    const workspaceRoot = join(tmpdir(), `cms-no-next-${Date.now()}-${Math.random()}`)
    const handle = createDevServer({ workspaceRoot, port: 3210 })
    const status = await handle.start()
    expect(status.state).toBe('error')
    expect(status.message).toContain(join('node_modules', 'next'))
    expect(status.pid).toBeNull()
  })

  it('stop() 幂等：从未启动与重复调用都返回 stopped', async () => {
    const workspaceRoot = join(tmpdir(), `cms-no-next-${Date.now()}-${Math.random()}`)
    const handle = createDevServer({ workspaceRoot, port: 3210 })
    expect((await handle.stop()).state).toBe('stopped')
    expect((await handle.stop()).state).toBe('stopped')
    expect(handle.status().state).toBe('stopped')
    expect(handle.logs()).toBe('')
  })

  it('状态变化会通过 onEvent 回调透出', async () => {
    const workspaceRoot = join(tmpdir(), `cms-no-next-${Date.now()}-${Math.random()}`)
    const seen: string[] = []
    const handle = createDevServer({
      workspaceRoot,
      port: 3210,
      onEvent: (status) => seen.push(status.state)
    })
    await handle.start()
    expect(seen).toContain('error')
  })
})
