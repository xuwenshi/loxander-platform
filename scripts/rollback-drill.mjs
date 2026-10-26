#!/usr/bin/env node
/**
 * 回滚演练（方案 §16.2 内容源回滚）。
 *
 * 为什么是「同进程起服务再自测」：
 *   本机沙箱禁止 fork 子进程（`next build` / `next dev` / `vitest` 全 spawn EPERM），
 *   所以不能「起一个 server 进程，再起一个 client 进程去打它」。
 *   startServer() 是**同进程**监听，之后用全局 fetch 打自己 —— 一条命令做完，不需要外部保活。
 *
 * 四条腿（带负控制，否则「两边都绿」可能只是「两边其实都跑了同一个源」）：
 *   A. CONTENT_SOURCE=db       + 真库     → 必须全绿
 *   B. CONTENT_SOURCE=markdown + 真库     → 必须全绿（回滚可用）
 *   C. CONTENT_SOURCE=db       + 坏库     → 必须出问题（证明 db 模式真的依赖数据库）
 *   D. CONTENT_SOURCE=markdown + 坏库     → 必须全绿（证明回滚后不再依赖数据库）
 *
 * 用法：
 *   node scripts/rollback-drill.mjs <db|markdown> <good|bad> [port]
 *
 * 四条腿都要跑一遍才算完成（C/D 是负控制，缺了它们「全绿」可能只是假象）：
 * ```
 * node scripts/rollback-drill.mjs db       good 3467
 * node scripts/rollback-drill.mjs markdown good 3468
 * node scripts/rollback-drill.mjs db       bad  3469
 * node scripts/rollback-drill.mjs markdown bad  3470
 * ```
 *
 * 前置：先 `npm run build:web:local`（脚本跑的是构建产物，不是 dev）。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// 脚本住在 scripts/ 子目录，仓库根是上一级 —— 用 ".." 而不是 "."，
// 否则 `createRequire` 会去找 `scripts/package.json`（不存在）。
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_WEB = path.join(HERE, "apps", "web");
const require = createRequire(path.join(HERE, "package.json"));

process.env.NODE_ENV = "production";
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = "";

const [mode, dbKind, portArg] = process.argv.slice(2);
if (!["db", "markdown"].includes(mode) || !["good", "bad"].includes(dbKind)) {
  console.error("用法：node .tmp-rollback-drill.mjs <db|markdown> <good|bad> [port]");
  process.exit(2);
}
const PORT = Number.parseInt(portArg ?? "3411", 10);
const BASE = `http://127.0.0.1:${PORT}`;
const LABEL = `${mode}/${dbKind}`;

// 真库连接串来自 .env；坏库用一个语法合法但连不上的串（不确定端口，必超时）
const envText = fs.readFileSync(path.join(HERE, ".env"), "utf8");
const goodUrl = envText.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="))?.slice("DATABASE_URL=".length);
if (!goodUrl) {
  console.error(".env 里找不到 DATABASE_URL");
  process.exit(2);
}
const BAD_URL = "postgresql://nobody:nobody@127.0.0.1:1/nothing?sslmode=require&connect_timeout=2";

process.env.CONTENT_SOURCE = mode;
process.env.DATABASE_URL = dbKind === "good" ? goodUrl : BAD_URL;

/**
 * `expect` 是这条路由**必须**返回的状态码。
 * 之前漏写这个字段，`/blog/week01`（week01 其实是 diary 的 slug）返回 404 却被当成 ✅ ——
 * 因为它小于 500。「不报错」和「对」是两件事，必须显式写出预期值。
 */
const ROUTES = [
  { path: "/", expect: 200 },
  { path: "/blog", expect: 200 },
  { path: "/blog/rag-chunking-strategies", expect: 200 },
  { path: "/projects", expect: 200 },
  { path: "/projects/crop-yield-prediction", expect: 200 },
  { path: "/diary", expect: 200 },
  { path: "/diary/week01", expect: 200 },
  { path: "/goals", expect: 200 },
  { path: "/tags", expect: 200 },
  { path: "/search?q=markdown", expect: 200 },
  { path: "/admin", expect: 307 },
  { path: "/api/health", expect: 200 },
  { path: "/blog/this-slug-does-not-exist", expect: 404 },
];

/**
 * 坏库腿下**期望值本身就该不一样**的两条 —— 这是负向对照的意义所在，
 * 不是「不符合预期」。把它们写成全局期望会让 C/D 两条腿永远假红：
 *
 * - `/api/health`：库挂了 health 必须报 `503`，报 200 才叫缺陷。这一条与
 *   `CONTENT_SOURCE` 无关 —— health 永远查库。
 * - `/blog/this-slug-does-not-exist`：db 源下库连不通时 `probePageExists` 返回
 *   `null`（无法判定），`proxy.ts` 的 `probeWithTimeout` 按 `result !== false`
 *   放行 —— 这是文件头写明的刻意权衡：「可选的 404 纠偏不该把站点变成 500」。
 *   代价就是库挂时软 404 会回来。所以坏库腿期望 `200`。
 *
 * markdown 源不查库，坏库对它无影响，因此那条保持正常期望。
 */
const BAD_DB_OVERRIDES = {
  "/api/health": 503,
  "/blog/this-slug-does-not-exist": 200,
};

/**
 * 坏库腿下**无法判定、必须跳过**的路由。
 *
 * `/blog/this-slug-does-not-exist` 在 `db` + 坏库下实测拿到的是
 * `The operation was aborted due to timeout`（30s 探针超时）——
 * 因为 proxy 放行之后，**页面自己**要去渲染，而 `getPost()` 会阻塞在
 * postgres-js 的连接上。这条请求的结果取决于驱动层的连接超时，
 * 不是 proxy 的行为，测它只会测出「坏库到底挂多久」。
 *
 * 跳过而不是改期望：把「超时」硬编码成期望值等于把一次环境抖动固化进断言。
 * 负向对照的论点（db 源真的依赖库）由 `/api/health` → 503 与 stderr 里
 * 那一串 `Failed query:` 已经充分证明。
 */
const SKIP_IN_BAD_DB = new Set(["/blog/this-slug-does-not-exist"]);

const startServerModule = require("next/dist/server/lib/start-server");
const startServer = startServerModule.startServer ?? startServerModule.default;

/**
 * 等服务器能接请求。
 *
 * ⚠️ **不能用 `/api/health` 探活**：health 自己会查库，坏库腿下它必然非 200，
 * 于是「服务器就绪」与「数据库健康」被混成一件事，C/D 两条负控制腿永远跑不到断言。
 * 这里改用 `/login`（纯页面、不查库、不存在时也至少会回一个 <500 的响应），
 * 只要拿到**任何 HTTP 响应**就说明监听已就绪。
 */
async function waitReady(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/login`, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      if (res.status < 500) return true;
    } catch {
      /* 还没起 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function probe() {
  const rows = [];
  for (const route of ROUTES) {
    // `/api/health` 永远查库，与 CONTENT_SOURCE 无关 —— 坏库腿下两种源都应 503。
    if (dbKind === "bad" && route.path === "/api/health") {
      const res = await fetch(BASE + route.path, {
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
      rows.push({
        route: route.path,
        expect: 503,
        status: res.status,
        ok: res.status === 503,
        bytes: (await res.text()).length,
      });
      continue;
    }

    // 只有「db 源 + 坏库」才启用覆盖表与跳过表（markdown 源不查库）。
    const applyOverride = dbKind === "bad" && mode === "db";
    if (applyOverride && SKIP_IN_BAD_DB.has(route.path)) {
      rows.push({ route: route.path, expect: null, status: null, ok: true, skipped: true });
      continue;
    }
    const expect =
      applyOverride && route.path in BAD_DB_OVERRIDES
        ? BAD_DB_OVERRIDES[route.path]
        : route.expect;
    const t0 = Date.now();
    try {
      const res = await fetch(BASE + route.path, {
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
      const body = await res.text();
      const errorPage = /Internal Server Error|Application error/.test(body.slice(0, 4000));
      rows.push({
        route: route.path,
        expect,
        status: res.status,
        ok: res.status === expect && !errorPage,
        location: res.headers.get("location"),
        bytes: body.length,
        ms: Date.now() - t0,
      });
    } catch (error) {
      rows.push({ route: route.path, expect, ok: false, error: error.message });
    }
  }
  return rows;
}

console.log(`\n[SERVER] CONTENT_SOURCE=${mode} DATABASE_URL=${dbKind === "good" ? "真库" : "坏库"} port=${PORT}`);
await startServer({
  dir: APP_WEB,
  isDev: false,
  hostname: "127.0.0.1",
  port: PORT,
  allowRetry: false,
  keepAliveTimeout: undefined,
});

const ready = await waitReady(60000);
console.log(`[SERVER] ready=${ready}`);

/**
 * 预热 `/api/health`，让 Neon 从冷启动状态醒来再断言。
 *
 * ── 为什么必须预热（真实竞态，不是脚本洁癖）──────────────────────────
 * 首轮实测：`/api/health` 首次请求耗时 **4754ms**，而它内部是
 * `PROBE_TIMEOUT_MS = 3000` + 超时后 `PROBE_RETRY_TIMEOUT_MS = 3000` 的两段式
 * （见 `apps/web/src/lib/health.ts:47,84`）。Neon 免费版冷启动实测 4320ms，
 * 于是「刚起容器就立刻断言 health」有一半概率拿到 **503**。
 *
 * 上一版就在这上面假红过一次：`markdown/good` 首次 12/13（唯一失败是 health），
 * 紧接着复跑同一个命令就 13/13 —— 402ms 与 4754ms 的差别纯粹是数据库醒没醒。
 * 这种「重跑就绿」的假红最坏的后果是让人开始无视红色。
 *
 * 预热只是**先把连接打热**，不放宽任何断言：醒了之后 health 仍是 200。
 * 失败不抛错 —— 真坏库腿（dbKind === "bad"）本来就该持续 503，
 * 那是被测行为，不是故障。
 */
if (dbKind === "good") {
  const warmupStart = Date.now();
  for (let i = 0; i < 6; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15000) });
      if (res.status === 200) break;
    } catch {
      /* 继续等 */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`[SERVER] health 预热完成，耗时 ${Date.now() - warmupStart}ms`);
}

const rows = ready ? await probe() : [];
console.log(`\n----- ${LABEL} -----`);
for (const r of rows) {
  if (r.skipped) {
    console.log(`  - ${"（跳过：坏库下由页面层连接超时决定，非 proxy 行为）"} ${r.route}`);
  } else if (r.error) {
    console.log(`  ✗ ${r.route.padEnd(38)} ERROR ${r.error}`);
  } else {
    const loc = r.location ? ` → ${r.location}` : "";
    console.log(
      `  ${r.ok ? "✓" : "✗"} ${String(r.status).padStart(3)} (期望 ${r.expect}) ${r.route.padEnd(38)} ${String(r.bytes).padStart(7)}B ${String(r.ms ?? 0).padStart(5)}ms${loc}`,
    );
  }
}
const bad = rows.filter((r) => !r.ok);
const counted = rows.filter((r) => !r.skipped);
console.log(`\n[结果] ${LABEL}：${counted.length - bad.length}/${counted.length} 符合预期`);
if (bad.length > 0) {
  console.log(`[失败] ${bad.map((r) => `${r.route}(实际${r.status ?? "ERR"}期望${r.expect})`).join("  ")}`);
}

fs.writeFileSync(
  path.join(HERE, `.tmp-drill-${mode}-${dbKind}.json`),
  JSON.stringify({ label: LABEL, ready, rows }, null, 2),
  "utf8",
);

// keep-alive socket 会吊住 uv 循环，跑完直接退
process.exit(bad.length === 0 && rows.length === ROUTES.length ? 0 : 1);
