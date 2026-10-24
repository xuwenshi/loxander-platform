import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // 两个 @loxander/* 包直接以 TS 源码形式被消费，需要 Next 参与转译。
  // 相关文档：node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/transpilePackages.md
  transpilePackages: ["@loxander/content-core", "@loxander/markdown"],
  /*
    Server Actions 的请求体上限（P5 媒体上传需要）。

    ── 为什么必须显式配 ──────────────────────────────────────────────────
    Next 16 的默认上限是 **1MB**（`node_modules/next/dist/docs/01-app/02-guides/
    server-actions.md:83` 逐字：「Action requests are capped at 1MB by default.
    Configure `serverActions.bodySizeLimit` when accepting larger payloads.」）。
    媒体层允许的图片上限是 10MB（`lib/media/image-info.ts` 的 `MAX_IMAGE_BYTES`），
    如果不抬这个值，**超过 1MB 的图在框架层就被拒了，根本走不到我们的校验逻辑** ——
    表现为「上传 2MB 的图，页面报一个和图片格式毫无关系的框架错误」，
    而不是我们精心写的「图片超过 10MB」。

    ── 为什么写在 experimental 下 ────────────────────────────────────────
    Next 16 把 `serverActions` 从顶层挪进了 `experimental`
    （实测 `node_modules/next/dist/server/config-shared.d.ts:1088` 该字段在
    `experimental` 块内；写在顶层会被 `NextConfig` 类型直接拒掉，
    报 `TS2353: 'serverActions' does not exist in type 'NextConfig'`）。
    文档里仍写作 `serverActions.bodySizeLimit`，是这个版本的类型与文档不同步。

    ── 为什么是 11mb 而不是 10mb ─────────────────────────────────────────
    multipart/form-data 除了文件本体还有 boundary、字段名、alt 文本等开销，
    留 1MB 余量。定成正好 10mb 会让「刚好 10MB 的图」在边界上时好时坏。
  */
  experimental: {
    serverActions: {
      bodySizeLimit: "11mb",
    },
  },
  turbopack: {
    // turbopack.root 指到仓库根，让 Turbopack 能覆盖 apps/web 与 packages/* 共同祖先。
    // 相关文档：node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopack.md
    root: path.resolve(__dirname, "../.."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  /*
    全站安全响应头（P6）。

    ── 为什么放在这里而不是 proxy.ts ──────────────────────────────────────
    `proxy.ts`（原 middleware）的 matcher 是
    `["/((?!_next/|api/|.*\\..*).*)"]` —— 它**故意**排除了 `api/`、`_next/`
    和带扩展名的静态资源。把安全头写进 proxy 会出现两个后果：
    ①`/api/*` 完全没有安全头（健康检查、auth 回调都在这条路径上）；
    ②静态资源（`/images/*.svg`、字体）也没有，而它们恰恰是最容易被
    `X-Content-Type-Options: nosniff` 保护的对象。
    `headers()` 在 Next 里是**响应层**的通用钩子，对全部路由与静态资源生效，
    所以它才是放安全头的正确位置。

    ── 这些头在 next dev 下也生效吗 ──────────────────────────────────────
    会。Next 对 `headers()` 不做 dev/prod 区分，dev server 的响应同样带这些头，
    所以本地可以用 fetch 验。反过来要注意：**`Strict-Transport-Security` 在
    http://localhost 下会被浏览器忽略**（HSTS 只对 https 生效），
    这是浏览器行为，不是配置没生效 —— 不要为了本地「看得见」而把它删掉。

    ── 一个已知限制 ──────────────────────────────────────────────────────
    `next build` 在本机跑不起来（沙箱禁 fork 子进程，报 `spawn EPERM`），
    所以这些头只经过「dev 实测 + 离线断言（security-headers.test.ts）」，
    没有经过生产构建验证。这是本机环境的限制，不是代码问题。
  */
  async headers() {
    /*
      ── CSP 的取舍：为什么必须留 'unsafe-inline' ────────────────────────
      两处硬依赖，都无法在本轮去掉：

      1. `app/layout.tsx` 的 `themeInitScript` 是**内联 `<script>`**，
         在 `<head>` 里同步执行、读 localStorage 决定要不要给 `<html>` 加
         `.dark`。它必须在浏览器首次绘制前跑完，否则暗色模式用户会先看到
         一帧白底（FOUC）。要它不用内联，只能改成外部脚本文件 ——
         外部脚本的请求与执行顺序不受 `<head>` 位置保证，FOUC 会回来。

      2. `packages/markdown/src/pipeline.ts` 用 Shiki 双主题输出高亮，
         语法高亮是**逐 token 的内联 `style`**（`SHIKI_OPTIONS` 里
         `themes: { light, dark }` + `defaultColor: "light"`），
         一篇带代码块的文章就有上千个内联 style 属性。
         要它不用内联，只能改成 CSS class + 预生成样式表，
         那是 Shiki 的另一套输出模式，会改变现有文章的渲染字节。

      折衷结论：`script-src` 与 `style-src` 都保留 `'unsafe-inline'`。
      这个折衷的真实代价是「注入的内联脚本仍会执行」，
      而**注入面已经被上游掐住了**：
      - Markdown 侧 `remarkRehype` 未开 `allowDangerousHtml`，raw HTML 本来就被丢弃；
      - 后台预览侧额外过 `rehype-sanitize` + DOMPurify（`lib/admin/preview.ts`）；
      - 内容只能由白名单管理员写入（`lib/auth.ts` 的 `callbacks.signIn`）。
      所以本轮的风险面是「管理员账号被完全接管」，而不是「访客可注入」。

      要真正收紧，需要的是一次独立改造：nonce（每次请求生成、经 header 传给
      服务端组件注入）+ themeInitScript 外置 + Shiki 改 class 模式。
      这三件事都会改变现有渲染行为，不属于 P6「预览环境验收」的范围。

      ── 为什么不写 'unsafe-eval' ─────────────────────────────────────────
      Next 16 的 dev 模式（Turbopack HMR）需要 eval，生产不需要。
      这里写的是**生产策略**，不掺 dev 例外；如果将来本地调试被 CSP 挡住，
      应该用 dev 专用的 `headers()` 分支，而不是把 'unsafe-eval' 加进生产策略。
    */
    const contentSecurityPolicy = [
      "default-src 'self'",
      // 内联脚本：见上方取舍说明（themeInitScript + JSON-LD）
      "script-src 'self' 'unsafe-inline'",
      // 内联样式：见上方取舍说明（Shiki 逐 token style）
      "style-src 'self' 'unsafe-inline'",
      // data:/blob: 供图片预览；Blob 域名来自 lib/media/storage.ts 的对象存储
      "img-src 'self' data: blob: https://*.public.blob.vercel-storage.com",
      "font-src 'self' data:",
      // 不放开任何外部 connect：本站不调用第三方 API
      "connect-src 'self'",
      // 与 X-Frame-Options: DENY 重复，但 CSP 是给现代浏览器、XFO 是给老浏览器
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");

    return [
      {
        /*
          只写一条 `/(.*)`，覆盖全部路由（含 api 与静态资源）。
          不要为单个路由再写一条：Next 的 headers 是**追加**语义，
          同一响应上会出现两个同名头，浏览器按逗号拼接后 CSP 会变成
          多份策略求交集 —— 结果是越写越严、且极难排查。
        */
        source: "/(.*)",
        headers: [
          {
            // 两年 + 子域 + preload。注意 preload 意味着一旦提交 HSTS 预加载列表
            // 就难以撤回，所以只在确认全站 https 后再考虑提交。
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            // 禁止浏览器嗅探 MIME：上传的 SVG/图片被当成 HTML 解析是经典 XSS 路径
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            // 禁止被 iframe 嵌套（点击劫持）
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            // 跨站时只发 origin，不发完整路径 —— 后台路径里含 slug，不该外泄
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            // 本站不需要摄像头/麦克风/定位；interest-cohort 显式关闭 FLoC 类追踪
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
