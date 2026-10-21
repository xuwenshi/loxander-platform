import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // 固定项目根目录为 monorepo 仓库根，而不是 apps/web。
    //
    // 两个原因：
    // 1. 避免 Turbopack 向上探测到 C:\Users\luoxu 下的 lockfile（原注释保留）。
    // 2. monorepo 下必须指向仓库根：`next` 与其它依赖被 npm workspaces 提升到
    //    仓库根的 node_modules，P1 起的 packages/* 也在 apps/web 之外。
    //    若 root 仍写成 process.cwd()（= apps/web），这些目录就落在 root 之外，
    //    Turbopack 不会解析，构建直接报 "Could not find the Next.js package"。
    //    详见 docs/adr/0001-adopt-monorepo.md 负面后果 4，以及
    //    node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopack.md
    //    第 115–117 行（monorepo 场景应把 root 设为包含 apps 与 packages 的父目录）。
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
