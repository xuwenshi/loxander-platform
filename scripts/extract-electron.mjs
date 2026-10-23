/**
 * 手工解压 Electron 二进制。
 *
 * 背景：node_modules/electron 的 postinstall（install.js）在本机跑过，zip 已经完整
 * 落到 %LOCALAPPDATA%\electron\Cache\（136MB），但 extract-zip 解压时中途卡住，
 * dist/ 里只留下 locales/sr.pak，没有 electron.exe。这里用系统自带的 tar.exe
 * （Windows 10+ 的 bsdtar，支持 zip）来解压，绕开 extract-zip。
 *
 * 跑法：node scripts/extract-electron.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const electronDir = path.join(repoRoot, 'node_modules', 'electron')
const dist = path.join(electronDir, 'dist')

const wanted = 'electron-v38.8.6-win32-x64.zip'
const cacheRoot = path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache')

let zip = null
if (fs.existsSync(cacheRoot)) {
  for (const dir of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, dir, wanted)
    if (fs.existsSync(candidate)) {
      zip = candidate
      break
    }
  }
}

if (!zip) {
  console.error('找不到缓存的 zip:', wanted)
  process.exit(1)
}

console.log('repoRoot =', repoRoot)
console.log('zip      =', zip)
console.log('zip size =', fs.statSync(zip).size)
console.log('dist     =', dist)

fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })

// tar.exe 用 -x 解 zip，-C 指定目标目录；Windows 自带 bsdtar 支持 zip
const result = spawnSync('tar', ['-xf', zip, '-C', dist], { stdio: 'inherit' })
console.log('tar exit =', result.status, result.error ? result.error.message : '')

const exe = path.join(dist, 'electron.exe')
const exists = fs.existsSync(exe)
console.log('electron.exe =', exists, exists ? fs.statSync(exe).size + 'B' : '')
if (!exists) process.exit(1)

fs.writeFileSync(path.join(electronDir, 'path.txt'), 'electron.exe')
console.log('path.txt 已写入')

const top = fs.readdirSync(dist)
console.log('dist 顶层条目数 =', top.length)
console.log('前 10 个 =', top.slice(0, 10).join(', '))
console.log('version 文件 =', fs.existsSync(path.join(dist, 'version')) ? fs.readFileSync(path.join(dist, 'version'), 'utf8') : '(缺失)')
