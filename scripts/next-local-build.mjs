#!/usr/bin/env node
/**
 * 本机受限沙箱下的 `next build` 启动器。
 *
 * 为什么需要它：本机执行环境禁止 fork 子进程（`spawn EPERM` / `errno -4048`），
 * 而 `next build` 默认会起三类子进程：
 *   1. TypeScript 类型检查（`experimental.useTypeScriptCli` 默认 true → 起 `tsc` CLI）
 *   2. jest-worker 静态生成 worker（`experimental.workerThreads` 默认 false → `child_process.fork`）
 *   3. webpack 编译 worker（`experimental.webpackBuildWorker`）
 * 三者任一被拦，构建就停在对应阶段。
 *
 * 解法不是「跳过检查」，而是**把这三处改成同进程内执行**：
 *   - `useTypeScriptCli: false` → 用进程内的 TypeScript API 做类型检查
 *   - `workerThreads: true` → jest-worker 走 `worker_threads`（线程不 fork）
 *   - `webpackBuildWorker: false` → webpack 编译留在主进程
 *   - `cpus: 1` → 减少 worker 数量（本机只有单核可用）
 *
 * 用法：
 *   node scripts/next-local-build.mjs            # 构建
 *   node scripts/next-local-build.mjs --keep-types-errors
 *                                                # 保留类型错误（默认也保留，只是显式说明）
 *
 * 产物与 `npm run build:web` 完全一致（`apps/web/.next/`），
 * 唯一的区别是「没有在 Vercel 的构建环境里产生」—— 见执行记录 §10.12 第 1 条。
 *
 * 注意：这个脚本**不能替代 CI**。它存在的意义是让本机有能力验证「生产构建产物」，
 * 从而让 P7 的软 404 这类「只在生产模式下暴露」的缺陷有机会被发现。
 */
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const APP_WEB = path.join(REPO_ROOT, "apps", "web");

const require = createRequire(path.join(REPO_ROOT, "package.json"));

/**
 * `next build` 的 `bundler` 参数是数字枚举，不是字符串。
 * 实测 `node_modules/next/dist/build/index.d.ts` 的签名：
 *   build(dir, analyze, reactProductionProfiling, debugOutput, debugPrerender,
 *         noMangling, appDirOnly, bundler, experimentalBuildMode,
 *         traceUploadUrl, debugBuildPathsPatterns, enabledFeatures?)
 * 13 个位置参数，前 7 个传 false 表示全关。
 */
const BUNDLER_TURBOPACK = 0;
const BUNDLER_WEBPACK = 1;
const BUNDLER_RSPACK = 2;

/**
 * 用 Webpack 而不是 Turbopack：
 * Turbopack 的构建会走 Rust 侧的子进程/线程池，沙箱下不可控；
 * Webpack 的 `webpackBuildWorker: false` 能明确地留在主进程。
 */
const BUNDLER = BUNDLER_WEBPACK;

/**
 * 覆盖 `next/dist/server/config` 的默认导出，在原始 `loadConfig` 返回之后
 * 强行改写实验项。**必须在 `require("next/dist/build")` 之前完成替换**，
 * 因为 build 模块在加载时就会 `require` 配置模块并缓存引用。
 */
function patchNextConfig() {
  const configModulePath = require.resolve("next/dist/server/config");
  const configModule = require(configModulePath);
  const originalLoadConfig = configModule.default;

  if (typeof originalLoadConfig !== "function") {
    throw new Error(
      `[next-local-build] next/dist/server/config 的 default 不是函数（拿到 ${typeof originalLoadConfig}）` +
        " —— Next 的内部结构变了，需要重新确认 loadConfig 的导出位置。",
    );
  }

  const patchedLoadConfig = async (...args) => {
    const config = await originalLoadConfig(...args);

    config.experimental = {
      ...config.experimental,
      useTypeScriptCli: false,
      workerThreads: true,
      webpackBuildWorker: false,
      cpus: 1,
    };

    // 类型检查已经在 `npm run typecheck:web` 里做过（那是独立闸门，且能给出准确行号）。
    // 这里再让 build 内部跑一次，只会引入「子进程被拦」的风险，不增加任何信息。
    config.typescript = { ...config.typescript, ignoreBuildErrors: true };
    // ESLint 同理：`npm run lint` 是独立闸门。
    config.eslint = { ...config.eslint, ignoreDuringBuilds: true };

    return config;
  };

  // 直接改 require.cache 里的 exports，而不是写文件 —— 写文件会污染 node_modules。
  //
  // ⚠️ 这里有两个坑，都是 P7 收口后把临时脚本固化成仓库脚本时真实踩到的：
  //
  // 坑 1：不能写 `configModule.default = patchedLoadConfig`。
  //   `next/dist/server/config` 的导出对象上 `default` 是用
  //   `Object.defineProperty(target, name, { enumerable: true, get })` 装的
  //   （`config.js:14-20` 的 `_export`），只有 getter 且 **configurable: false**：
  //     TypeError: Cannot set property default of #<Object> which has only a getter
  //
  // 坑 2：不能写 `{ ...exports, default: patched }`。
  //   展开运算符只复制**可枚举**的自有属性，而 `__esModule: true` 是
  //   `Object.defineProperty(exports, "__esModule", { value: true })` 定义的，
  //   **不可枚举** → 新对象丢掉 `__esModule`。于是 Next 内部
  //   `_interopRequireDefault(require(".../config"))` 会走「非 ESM」分支，
  //   把整个对象包成 `{ default: 整个对象 }`，`(0, _config.default)(...)` 就变成
  //   `TypeError: (0 , _config.default) is not a function`（`build/index.js:497`）。
  //
  // 正确做法：用 `Object.create(原型, 全部属性描述符)` 克隆（描述符复制不受
  // 可枚举性影响，`__esModule` 会一起带过来），再在新对象上**新定义** `default`
  // —— 新对象上的同名属性是我们自己加的，可写。
  const cacheEntry = require.cache[configModulePath];
  if (cacheEntry === undefined) {
    throw new Error("[next-local-build] require.cache 里没有 next/dist/server/config。");
  }

  // 复制描述符时**必须跳过 `default`**：原描述符是
  // `{ enumerable: true, configurable: false, get: loadConfig }`，
  // 原样复制到新对象上之后，`defineProperty(newObj, "default", ...)` 会抛
  //   TypeError: Cannot redefine property: default
  // （configurable: false 意味着这个属性在新对象上也不能被重新定义。）
  const descriptors = Object.getOwnPropertyDescriptors(cacheEntry.exports);
  delete descriptors.default;

  const patchedExports = Object.create(
    Object.getPrototypeOf(cacheEntry.exports),
    descriptors,
  );
  Object.defineProperty(patchedExports, "default", {
    value: patchedLoadConfig,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  cacheEntry.exports = patchedExports;

  return configModulePath;
}

async function main() {
  const startedAt = Date.now();

  const configModulePath = patchNextConfig();
  console.log(`[next-local-build] 已打补丁：${path.relative(REPO_ROOT, configModulePath)}`);

  const buildModule = require("next/dist/build");
  const build = buildModule.default ?? buildModule;
  if (typeof build !== "function") {
    throw new Error("[next-local-build] next/dist/build 的 default 不是函数。");
  }

  process.env.NODE_ENV = "production";

  try {
    await build(
      APP_WEB, // dir：**必须是绝对路径**，相对路径会报
      // `configuration[0].context: The provided value "apps/web" is not an absolute path!`
      false, // analyze
      false, // reactProductionProfiling
      false, // debugOutput
      false, // debugPrerender
      false, // noMangling
      false, // appDirOnly
      BUNDLER, // bundler
      "default", // experimentalBuildMode
      undefined, // traceUploadUrl
      undefined, // debugBuildPathsPatterns
    );
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    console.error(`\n[next-local-build] BUILD_FAILED in ${elapsed}ms`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }

  const elapsed = Date.now() - startedAt;
  console.log(`\n[next-local-build] BUILD_OK in ${elapsed}ms`);
  console.log(`[next-local-build] 产物：${path.join("apps", "web", ".next")}`);
  console.log("[next-local-build] 下一步：node scripts/next-local-start.mjs");
}

await main();
