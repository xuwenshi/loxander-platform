import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 三段构建：main（特权层）/ preload（白名单桥）/ renderer（无 Node 权限的 UI）
// 注意：主进程与 preload 保留 CJS 输出（不设置 "type": "module"），
// 以保证 sandbox: true 下 preload 能被 Electron 正常加载。
//
// `@loxander/*` 是仓库内的 workspace 包，导出的是 TS 源码（package.json 的 main 指向 src/index.ts），
// 运行时没有可 require 的 JS 产物 —— 必须让它们参与打包，而不是被 externalize 掉。
// 因此这里用 `exclude` 把它们从「外部依赖」里摘出来，交给 Rollup 一起编译。
const WORKSPACE_PACKAGES = ['@loxander/content-core', '@loxander/markdown']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    // Tailwind 只负责布局层（Flex/Grid/间距/尺寸）；颜色与主题走 CSS 变量（见 styles.css）
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})