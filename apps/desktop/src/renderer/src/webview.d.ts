import type { DetailedHTMLProps, HTMLAttributes } from 'react'

/**
 * Electron 的 <webview> 不在 React 内建的 JSX 元素里，这里补上类型声明。
 * 只声明本项目实际用到的属性/方法；reloadIgnoringCache() 是「秒级刷新预览」的关键
 * （实测普通 reload 对 .md 改动会持续拿到陈旧内容，只有 no-cache 重载才立即生效）。
 */
export interface WebviewElement extends HTMLElement {
  src: string
  partition: string
  /** 等价于发送 Cache-Control: no-cache */
  reloadIgnoringCache(): void
  /** 当前加载地址（可用于日志/排障） */
  getURL(): string
}

// React 19 里 JSX 命名空间位于 React 内部（React.JSX），模块增补即并入其中
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<WebviewElement>, WebviewElement> & {
        src?: string
        partition?: string
      }
    }
  }
}
