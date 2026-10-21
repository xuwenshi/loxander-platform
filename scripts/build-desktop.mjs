#!/usr/bin/env node
/**
 * 桌面端构建包装器（`npm run build:desktop` 走这里）。
 *
 * 为什么需要它：
 * electron-vite 的 renderer 构建会经过 Vite 内部的 `vite:esbuild-transpile` 插件，
 * 该插件用 esbuild 的 service 做转译，而 esbuild 的 service 把临时目录硬编码成
 * `os.tmpdir()`（Windows 上读 TMP / TEMP）。在受限的机器上，`%LOCALAPPDATA%\Temp`
 * 的 ACL 会拒绝 esbuild 事后删除自己的临时文件，构建因此以
 *
 *   [vite:esbuild-transpile] remove C:\Users\<user>\AppData\Local\Temp\esbuild-...: Access is denied.
 *
 * 失败。这个问题与仓库代码无关（P0 阶段用未改动的 electron-cms 原仓库对照，
 * 报的是完全相同的错误），纯粹是「esbuild 的临时目录落在了一个它自己删不掉的地方」。
 *
 * 修法：在启动 electron-vite 之前把 TMP / TEMP 指向仓库内的临时目录，
 * 让 esbuild 的 service 继承这两个变量。这样临时文件始终落在工作区内，
 * 构建结束由本脚本清理，不再受系统 Temp 的 ACL 影响。
 *
 * 顺带说明：不采用「把 renderer 的 build.target 改成 esnext」来绕开
 * esbuild-transpile —— 那是用改构建语义的方式回避环境问题，会让产物丢掉
 * 针对 Electron Chromium 的下调语法转换，属于隐性代价。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const desktopDir = resolve(repoRoot, 'apps/desktop')
const tmpDir = resolve(repoRoot, '.esbuild-tmp')

mkdirSync(tmpDir, { recursive: true })

// Windows 的 electron-vite 入口是 .cmd shim，其余平台是 .js；
// 这里统一用 node 直接跑包里的 JS 入口，避免 shell 层差异。
const cliJs = resolve(repoRoot, 'node_modules/electron-vite/bin/electron-vite.js')
const command = existsSync(cliJs) ? process.execPath : 'electron-vite'
const args = existsSync(cliJs) ? [cliJs, 'build'] : ['build']

const child = spawn(command, args, {
  cwd: desktopDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    TMP: tmpDir,
    TEMP: tmpDir,
    TMPDIR: tmpDir
  }
})

child.on('error', (error) => {
  console.error(`[build-desktop] 启动 electron-vite 失败：${error.message}`)
  cleanup()
  process.exit(1)
})

child.on('exit', (code, signal) => {
  cleanup()
  if (signal) {
    console.error(`[build-desktop] electron-vite 被信号 ${signal} 终止`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})

function cleanup() {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch (error) {
    // 清理失败不影响构建结果，只提示一句，避免把成功包装成失败。
    console.warn(`[build-desktop] 临时目录清理失败（可忽略）：${error.message}`)
  }
}
