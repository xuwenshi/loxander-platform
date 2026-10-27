#!/usr/bin/env node
/**
 * 桌面快捷方式的入口：双击一下就把本地运维台打开。
 *
 * 它做四件事，顺序不能反：
 *   1. 先探 `/api/health` —— 服务已经在跑就**不要**再起一个（会占端口失败）
 *   2. 没有 `.next` 构建产物就先构建（`next-local-build.mjs`，约 40 秒）
 *   3. 后台起服务（detached，窗口关掉也不停）
 *   4. 等到 `/api/health` 返回 200 再开浏览器 —— 直接开会看到「无法访问此网站」
 *
 * 为什么不用 `next start`：
 *   本机沙箱禁止 fork 子进程（`spawn EPERM`），`next start` CLI 起不来。
 *   必须走 `scripts/next-local-start.mjs`（进程内调 `startServer()`）。
 *
 * 为什么端口是 3210 而不是启动器默认的 3310：
 *   `apps/web/.env.local` 里 `AUTH_URL=http://localhost:3210`，
 *   且 GitHub OAuth App 登记的回调是 `http://127.0.0.1:3210/api/auth/callback/github`。
 *   换端口会导致登录回调对不上。
 *
 * 为什么浏览器打开 `localhost` 而不是 `127.0.0.1`：
 *   会话 cookie 是 `AUTH_URL` 那个 origin 下发的，用另一个主机名访问拿不到 cookie，
 *   页面会一直显示「正在校验身份…」。
 *
 * 用法：
 *   node scripts/open-ops.mjs                # 起服务 + 开浏览器
 *   node scripts/open-ops.mjs --port 3400
 *   node scripts/open-ops.mjs --no-open      # 只起服务，不开浏览器（调试用）
 *   node scripts/open-ops.mjs --print-url    # 只打印 URL
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const APP_WEB = path.join(REPO_ROOT, "apps", "web");
const SERVER_LOG = path.join(REPO_ROOT, ".tmp-ops-server.log");

const HEALTH_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`[open-ops] --${name} 后面缺少值`);
  }
  return value;
}

const hasFlag = (name) => process.argv.includes(`--${name}`);

const PORT = Number.parseInt(readArg("port", "3210"), 10);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[open-ops] 端口不合法：${PORT}`);
  process.exit(1);
}

const ORIGIN = `http://localhost:${PORT}`;
const TARGET_URL = `${ORIGIN}/admin/ops`;

function say(message) {
  console.log(`[open-ops] ${message}`);
}

/** 返回 health 的 JSON（服务在跑），否则 null。 */
async function probeHealth() {
  try {
    const response = await fetch(`${ORIGIN}/api/health`, {
      signal: AbortSignal.timeout(3_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function hasBuild() {
  return fs.existsSync(path.join(APP_WEB, ".next", "BUILD_ID"));
}

function buildOnce() {
  say("没有构建产物（apps/web/.next/BUILD_ID 不存在），先构建 —— 约 40 秒，别关窗口。");
  const result = spawnSync(process.execPath, [path.join(HERE, "next-local-build.mjs")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`构建失败（退出码 ${result.status}），先手动跑一次：node scripts/next-local-build.mjs`);
  }
  say("构建完成。");
}

function startServerDetached() {
  // 日志追加写，出问题能翻。stdio 三路都要给，否则 detached 下拿不到任何输出。
  const logFd = fs.openSync(SERVER_LOG, "a");
  fs.writeSync(logFd, `\n===== ${new Date().toISOString()} 启动 ${ORIGIN} =====\n`);
  const child = spawn(
    process.execPath,
    [path.join(HERE, "next-local-start.mjs"), "--port", String(PORT)],
    {
      cwd: REPO_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    },
  );
  child.unref();
  fs.closeSync(logFd);
  say(`服务已在后台启动（PID ${child.pid}），日志：${path.relative(REPO_ROOT, SERVER_LOG)}`);
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const health = await probeHealth();
    if (health) {
      say(`服务就绪（第 ${attempts} 次探测），database=${health.database ?? "?"}`);
      return health;
    }
    if (attempts === 1) say("等待服务响应 /api/health …");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

function tailServerLog(lines = 25) {
  if (!fs.existsSync(SERVER_LOG)) return null;
  const text = fs.readFileSync(SERVER_LOG, "utf8");
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

function openBrowser(url) {
  // `start` 是 cmd 内建命令，必须经 cmd 转一手；第一个空参数是窗口标题位。
  const child = spawn("cmd", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function main() {
  if (hasFlag("print-url")) {
    console.log(TARGET_URL);
    return 0;
  }

  say(`目标：${TARGET_URL}`);

  const existing = await probeHealth();
  if (existing) {
    say("服务已经在跑，跳过启动。");
  } else {
    if (!hasBuild()) buildOnce();
    startServerDetached();
    const health = await waitForHealth();
    if (!health) {
      console.error(`\n[open-ops] ${HEALTH_TIMEOUT_MS / 1000} 秒内没等到服务就绪。`);
      const tail = tailServerLog();
      if (tail) console.error(`\n--- 日志最后 25 行（${path.relative(REPO_ROOT, SERVER_LOG)}）---\n${tail}`);
      console.error("\n排查：端口被占？构建过期？先手动跑 node scripts/next-local-start.mjs 看报错。");
      return 1;
    }
  }

  if (hasFlag("no-open")) {
    say("--no-open，不开浏览器。");
    return 0;
  }

  openBrowser(TARGET_URL);
  say("已在默认浏览器打开。服务会继续在后台跑；本窗口可以关闭。");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[open-ops] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
