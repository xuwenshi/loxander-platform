#!/usr/bin/env node
/**
 * 本机受限沙箱下的 `next start` 启动器（生产模式）。
 *
 * 为什么需要它：
 *   1. `next start` CLI 会 fork 子进程 → `spawn EPERM`
 *   2. 直接调 `startServer()` 还需要补两个环境变量，否则**每个请求都 500 ENOENT**
 *      （它在读 `.next/dev/required-server-files.json`，那是 dev 才有的文件）
 *   3. `dir` 必须是绝对路径，否则 webpack 报
 *      `configuration[0].context: The provided value "apps/web" is not an absolute path!`
 *
 * 用法：
 *   node scripts/next-local-start.mjs            # 默认 127.0.0.1:3310
 *   node scripts/next-local-start.mjs --port 3400
 *
 * 前置：必须先 `node scripts/next-local-build.mjs` 产出 `apps/web/.next`。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const APP_WEB = path.join(REPO_ROOT, "apps", "web");

const require = createRequire(path.join(REPO_ROOT, "package.json"));

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`[next-local-start] --${name} 后面缺少值`);
  }
  return value;
}

const PORT = Number.parseInt(readArg("port", "3310"), 10);
const HOSTNAME = readArg("hostname", "127.0.0.1");

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  throw new Error(`[next-local-start] 端口不合法：${PORT}`);
}

const BUILD_ID_PATH = path.join(APP_WEB, ".next", "BUILD_ID");
if (!fs.existsSync(BUILD_ID_PATH)) {
  console.error(
    "[next-local-start] 找不到 apps/web/.next/BUILD_ID —— 还没有生产构建产物。\n" +
      "  先跑：node scripts/next-local-build.mjs",
  );
  process.exit(1);
}

// 必须在 require start-server 之前设置：
// - NODE_ENV=production 让它走生产分支（不做 PPR 之外的 dev 编译）
// - __NEXT_PRIVATE_STANDALONE_CONFIG="" 让它不去找 standalone 配置
//   （不设这个，每个请求都会 500 ENOENT，因为它去读 .next/dev/required-server-files.json）
process.env.NODE_ENV = "production";
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = "";

const startServerModule = require("next/dist/server/lib/start-server");
const startServer = startServerModule.startServer ?? startServerModule.default;

if (typeof startServer !== "function") {
  console.error("[next-local-start] next/dist/server/lib/start-server 没导出 startServer。");
  process.exit(1);
}

const buildId = fs.readFileSync(BUILD_ID_PATH, "utf8").trim();
console.log(`[next-local-start] BUILD_ID = ${buildId}`);
console.log(`[next-local-start] 监听 http://${HOSTNAME}:${PORT}`);

await startServer({
  dir: APP_WEB,
  isDev: false,
  hostname: HOSTNAME,
  port: PORT,
  allowRetry: false,
  keepAliveTimeout: undefined,
});
