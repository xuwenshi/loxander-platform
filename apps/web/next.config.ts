import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // 两个 @loxander/* 包直接以 TS 源码形式被消费，需要 Next 参与转译。
  // 相关文档：node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/transpilePackages.md
  transpilePackages: ["@loxander/content-core", "@loxander/markdown"],
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
