import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  createDevServer,
  findFreePort,
  parseDevServerUrl,
  pickPort,
  probePort,
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

  it('只有端口自增提示时给出自增后的端口（旧文案）', () => {
    expect(parseDevServerUrl('Port 3210 is in use, trying 3211 instead')).toEqual({
      origin: null,
      port: 3211
    })
  })

  // Next 16 的真实文案（next/dist/server/lib/start-server.js:268-270），旧正则匹配不到，
  // 会导致端口自增时 origin/port 双双为 null → 预览永远停在「正在启动」。
  it('Next 16 真实文案：带 pid', () => {
    expect(
      parseDevServerUrl('⚠ Port 3210 is in use by process 1234, using available port 3211 instead.')
    ).toEqual({ origin: null, port: 3211 })
  })

  it('Next 16 真实文案：未知进程', () => {
    expect(
      parseDevServerUrl('⚠ Port 3210 is in use by an unknown process, using available port 3211 instead.')
    ).toEqual({ origin: null, port: 3211 })
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

/** 占用一个临时端口（listen 0 由系统分配），返回 {port, release} */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    release: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('probePort：真实 bind 探测（不依赖 spawn，可在沙箱内运行）', () => {
  it('端口已被占用时返回 false', async () => {
    const { port, release } = await occupyPort()
    try {
      expect(await probePort(port)).toBe(false)
    } finally {
      await release()
    }
  })

  it('端口空闲时返回 true', async () => {
    const { port, release } = await occupyPort()
    await release()
    // 刚释放的端口按定义是空闲的（无 TIME_WAIT 概念，因为从未建立连接）
    expect(await probePort(port)).toBe(true)
  })
})

describe('findFreePort：从首选端口向后找第一个真正空闲的端口', () => {
  it('首选被占用时跳过它，且返回的端口确实可用', async () => {
    const { port, release } = await occupyPort()
    try {
      const found = await findFreePort(port)
      expect(found).not.toBe(port)
      expect(found).toBeGreaterThan(port)
      expect(await probePort(found)).toBe(true)
    } finally {
      await release()
    }
  })

  it('首选空闲时原样返回', async () => {
    const { port, release } = await occupyPort()
    await release()
    expect(await findFreePort(port)).toBe(port)
  })

  it('非法首选值会被夹到合法端口区间', async () => {
    // 低于 1024 的端口会被抬到 1024 起（避免需要特权的端口）
    expect(await findFreePort(80)).toBeGreaterThanOrEqual(1024)
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
    // 未就绪：探测字段必须保持 null，UI 不能把它当成「探测失败」
    expect(status.verified).toBeNull()
    expect(status.verifyStatus).toBeNull()
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

  it('bin 缺失时不调用探测（probe 不该被触发）', async () => {
    const workspaceRoot = join(tmpdir(), `cms-no-next-${Date.now()}-${Math.random()}`)
    let probed = 0
    const handle = createDevServer({
      workspaceRoot,
      port: 3210,
      probe: async () => {
        probed += 1
        return { ok: true, status: 200 }
      }
    })
    await handle.start()
    expect(probed).toBe(0)
  })
})
