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
};

export default nextConfig;
