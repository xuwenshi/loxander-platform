/**
 * `/api/health` 与内存限流器的离线验收（不需要 Next 起服务，不需要真库）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 * 健康检查的全部风险都不在「能不能编译」，而在**判断**：
 * 数据库连不上时会不会仍然报 ok、故障时状态码还是不是 200、响应里会不会
 * 顺手把 `postgres://user:pass@host` 带出去、版本串有没有截断。这些 `tsc`
 * 一个都抓不到 —— 编译通过、页面照常渲染，只有真的调一次才看得出来。
 *
 * 而本机沙箱禁止子进程（`next build` / `next dev` 都是 `spawn EPERM`），
 * 所以这里退到「直接调 `GET()` + 打桩 `@/lib/admin/db`」。正因为把分支逻辑
 * 从 `route.ts` 挪进了 `lib/health.ts`，三条分支（ok / degraded / down）才能
 * 在这里被逐条断言，而 `route.ts` 只剩无分支的序列化。
 *
 * ── 两个必须打桩的东西 ────────────────────────────────────────────────
 * 1. `server-only` → `node_modules/server-only/empty.js`
 *    真实包在非 RSC 环境 import 时直接抛错，纯 node 里加载不了。
 *
 * 2. `@/lib/admin/db` → 一个 `data:` URL 形式的虚拟模块
 *    真实模块会去建 postgres 连接（沙箱里连不上，也没有库）。
 *    为什么用 `data:` URL 而不是新建一个 stub 文件：本任务的写范围只有
 *    四个文件，多一个 stub 文件会让 `git status` 多出第五条 `??`。虚拟模块
 *    把替身留在测试文件内部，验收标准「只多这四个文件」依然成立。
 *    替身本身不含逻辑，只把调用转发到 `globalThis.__healthAdminDbStub`，
 *    于是每个用例都能自己决定「这次是连上了还是抛错」。
 *
 * ── 为什么 registerHooks 必须在所有业务 import 之前 ────────────────────
 * 模块 resolve 发生在 import 的那一刻。先 `import` 再注册钩子，钩子永远
 * 不会被用上（`server-only` 会先炸）。所以这里所有业务模块都用**动态**
 * `await import()`，放在 `registerHooks` 之后。
 *
 * 跑法：`node --test-isolation=none apps/web/src/app/api/health/route.test.ts`
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `apps/web/src`（本文件在 `src/app/api/health/` 下，往上三层）。 */
const SRC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
/** `apps/web`。 */
const WEB_DIR = resolvePath(SRC_DIR, "..");
/** 仓库根 `loxander-platform`。 */
const REPO_DIR = resolvePath(WEB_DIR, "..", "..");

const SERVER_ONLY_EMPTY = resolvePath(REPO_DIR, "node_modules/server-only/empty.js");

/**
 * 虚拟的 `@/lib/admin/db`。
 *
 * 只有两件事：把 `getAdminDb()` / `hasDatabaseUrl()` 转给 `globalThis` 上的
 * 可控状态。故意**不**在这里复制任何判断（比如「没配 URL 就抛错」）——
 * 那属于被测代码的职责，复制过来等于让测试自己跟自己玩。
 */
const ADMIN_DB_STUB_URL =
  "data:text/javascript," +
  encodeURIComponent(
    [
      "export function getAdminDb() {",
      "  return globalThis.__healthAdminDbStub.getAdminDb();",
      "}",
      "export function hasDatabaseUrl() {",
      "  return globalThis.__healthAdminDbStub.hasUrl;",
      "}",
    ].join("\n"),
  );

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: pathToFileURL(SERVER_ONLY_EMPTY).href, shortCircuit: true };
    }

    // 必须排在通用 `@/` 规则之前，否则它会先被解析成真实文件。
    if (specifier === "@/lib/admin/db") {
      return { url: ADMIN_DB_STUB_URL, shortCircuit: true };
    }

    if (specifier.startsWith("@/")) {
      const base = resolvePath(SRC_DIR, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(base + ext)) {
          return { url: pathToFileURL(base + ext).href, shortCircuit: true };
        }
      }
      if (existsSync(base)) return { url: pathToFileURL(base).href, shortCircuit: true };
    }

    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const isRelative =
        specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:");
      if (!isRelative) throw error;
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
      const bare = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
      const target = resolvePath(dirname(parent), bare);
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(target + ext)) {
          return { url: pathToFileURL(target + ext).href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
});

/* -------------------------------------------------------------------------- */
/* 打桩控制器                                                                   */
/* -------------------------------------------------------------------------- */

/** 假的 drizzle 句柄：只需要 `execute`，因为探活只发 `select 1`。 */
interface FakeDb {
  execute: (query: unknown) => Promise<unknown>;
}

interface AdminDbStubState {
  hasUrl: boolean;
  getAdminDb: () => Promise<FakeDb>;
}

/**
 * 默认状态：配了库、连接成功。各用例只改自己关心的那一项，避免每个用例
 * 都要重写一遍完整状态（漏写一项就会串到下一个用例里，形成隐性耦合）。
 */
function installStub(overrides: Partial<AdminDbStubState> = {}): AdminDbStubState {
  const state: AdminDbStubState = {
    hasUrl: true,
    getAdminDb: async () => ({ execute: async () => [{ "?column?": 1 }] }),
    ...overrides,
  };
  (globalThis as unknown as { __healthAdminDbStub: AdminDbStubState }).__healthAdminDbStub = state;
  return state;
}

installStub();

import { test } from "node:test";
import assert from "node:assert/strict";

const health = await import("@/lib/health");
const route = await import("@/app/api/health/route");
const rateLimit = await import("@/lib/rate-limit");

/** 读响应体并断言 key 集合。健康检查的对外契约只有四个字段。 */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** 保存并恢复一组环境变量，避免用例之间互相污染。 */
function withEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) saved.set(key, process.env[key]);

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return run().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 1. 数据库探活的三种结论                                                        */
/* -------------------------------------------------------------------------- */

test("健康检查：数据库正常 → database=ok、ok=true、HTTP 200", async () => {
  installStub({ hasUrl: true });

  const report = await health.buildHealthReport();
  assert.equal(report.database, "ok");
  assert.equal(report.ok, true);

  const response = await route.GET();
  assert.equal(response.status, 200, "正常时必须 200");

  const json = await readJson(response);
  assert.equal(json.database, "ok");
  assert.equal(json.ok, true);
});

test("健康检查：数据库抛错 → database=down、ok=false、HTTP 503", async () => {
  installStub({
    hasUrl: true,
    getAdminDb: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    },
  });

  const report = await health.buildHealthReport();
  assert.equal(report.database, "down");
  assert.equal(report.ok, false);

  const response = await route.GET();
  assert.equal(response.status, 503, "故障时必须 503，否则监控看不见");
});

test("健康检查：没配 DATABASE_URL → degraded、ok=true、HTTP 200", async () => {
  // 「没配库」是配置状态而不是故障：纯 markdown 模式部署本来就不需要库。
  // 若把它报成 down，每一套静态部署的监控都会永久红着，于是没人再看这个接口。
  installStub({ hasUrl: false });

  const report = await health.buildHealthReport();
  assert.equal(report.database, "degraded");
  assert.equal(report.ok, true);

  const response = await route.GET();
  assert.equal(response.status, 200);
  const json = await readJson(response);
  assert.equal(json.database, "degraded");
  assert.equal(json.ok, true);
});

test("健康检查：没配库时根本不该去建连接", async () => {
  // 这条防的是「先连库再判断有没有配」这种顺序错误 —— 那样 degraded 分支
  // 会先抛错，最终被 catch 成 down，语义就反了。
  let called = false;
  installStub({
    hasUrl: false,
    getAdminDb: async () => {
      called = true;
      throw new Error("不应该被调用");
    },
  });

  const status = await health.checkDatabase();
  assert.equal(status, "degraded");
  assert.equal(called, false, "没配库时不能尝试取连接");
});

test("健康检查：探活超时 → down（不是无限等待）", async () => {
  // 探针挂住比返回 503 更糟：监控自己会超时，把「数据库慢」误报成「站点挂了」。
  // 这里真的等满 3 秒上限 —— 是整套测试里唯一一个慢用例，值得。
  installStub({
    hasUrl: true,
    getAdminDb: async () => ({ execute: () => new Promise<unknown>(() => {}) }),
  });

  const startedAt = Date.now();
  const status = await health.checkDatabase();
  const elapsed = Date.now() - startedAt;

  assert.equal(status, "down");
  assert.ok(elapsed >= 2_900, `应在约 3 秒后放弃（实际 ${elapsed}ms）`);
  assert.ok(elapsed < 10_000, `不能真的等下去（实际 ${elapsed}ms）`);
});

/* -------------------------------------------------------------------------- */
/* 2. 对外契约：字段、版本、响应头                                                */
/* -------------------------------------------------------------------------- */

test("健康检查：响应 JSON 恰好只有四个字段", async () => {
  installStub({ hasUrl: true });

  const response = await route.GET();
  const json = await readJson(response);

  // 逐字对齐方案 §15.2 的契约。多一个字段就可能是泄露：
  // 常见的翻车是「顺手带上 error.message 方便排查」，而健康检查往往是
  // 唯一一个没有鉴权、被公网直接探测的端点。
  assert.deepEqual(
    Object.keys(json).sort(),
    ["database", "ok", "timestamp", "version"],
    "响应字段必须恰好是契约里的四个",
  );
});

test("健康检查：故障时不泄露连接串与错误细节", async () => {
  const secretUrl = "postgres://blog:sup3r-secret@db.neon.tech/main?sslmode=require";
  installStub({
    hasUrl: true,
    getAdminDb: async () => {
      throw new Error(`could not connect to ${secretUrl}`);
    },
  });

  const response = await route.GET();
  const body = await response.text();

  // 方案 §15.2：「不得在响应中泄露连接串或内部错误细节」。
  assert.ok(!body.includes("sup3r-secret"), "响应里不能出现密码");
  assert.ok(!body.includes("postgres://"), "响应里不能出现连接串");
  assert.ok(!body.includes("ECONNREFUSED"), "响应里不能出现内部错误");
});

test("健康检查：version 从 env 读并截到 7 位短 sha", async () => {
  installStub({ hasUrl: true });

  await withEnv({ VERCEL_GIT_COMMIT_SHA: "6660d13a1b2c3d4e5f60718293a4b5c6d7e8f901" }, async () => {
    const report = await health.buildHealthReport();
    assert.equal(report.version, "6660d13", "必须截成 7 位短 sha");
  });

  // 自建 / CI 用 GIT_COMMIT_SHA。
  await withEnv(
    { VERCEL_GIT_COMMIT_SHA: undefined, GIT_COMMIT_SHA: "abcdef1234567890" },
    async () => {
      const report = await health.buildHealthReport();
      assert.equal(report.version, "abcdef1");
    },
  );

  // 都没有 → dev 原样返回（它本身就是一个有意义的信息：这不是可追溯的部署）。
  await withEnv(
    { VERCEL_GIT_COMMIT_SHA: undefined, GIT_COMMIT_SHA: undefined },
    async () => {
      const report = await health.buildHealthReport();
      assert.equal(report.version, "dev");
    },
  );
});

test("健康检查：timestamp 是合法 ISO 串", async () => {
  installStub({ hasUrl: true });

  const before = Date.now();
  const report = await health.buildHealthReport();
  const after = Date.now();

  const parsed = Date.parse(report.timestamp);
  assert.ok(Number.isFinite(parsed), `timestamp 必须可解析（实际 ${report.timestamp}）`);
  assert.ok(parsed >= before - 1_000 && parsed <= after + 1_000, "timestamp 应是当前时刻");
  assert.match(report.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("健康检查：Cache-Control 必须防缓存，Retry-After 只在 503 出现", async () => {
  installStub({ hasUrl: true });
  const ok = await route.GET();
  assert.match(ok.headers.get("cache-control") ?? "", /no-store/, "成功响应也必须 no-store");
  assert.equal(ok.headers.get("retry-after"), null, "200 不该带 Retry-After");

  installStub({
    hasUrl: true,
    getAdminDb: async () => {
      throw new Error("boom");
    },
  });
  const down = await route.GET();
  assert.match(
    down.headers.get("cache-control") ?? "",
    /no-store/,
    "故障响应必须 no-store（否则一次故障会被缓存住）",
  );
  assert.equal(down.headers.get("retry-after"), "10", "503 必须给 Retry-After 让客户端退避");

  // 健康检查是机器读的，Content-Type 必须明确是 UTF-8 JSON。
  assert.match(
    ok.headers.get("content-type") ?? "",
    /application\/json;\s*charset=utf-8/i,
  );
});

test("健康检查：ok 与状态码的映射规则自洽", () => {
  const base = { ok: true, version: "dev", timestamp: "2026-10-23T00:00:00.000Z" };

  assert.equal(health.healthHttpStatus({ ...base, ok: true, database: "ok" }), 200);
  assert.equal(health.healthHttpStatus({ ...base, ok: true, database: "degraded" }), 200);
  assert.equal(health.healthHttpStatus({ ...base, ok: false, database: "down" }), 503);
});

/* -------------------------------------------------------------------------- */
/* 3. 限流器                                                                    */
/* -------------------------------------------------------------------------- */

test("限流：前 N 次放行，第 N+1 次拒绝", () => {
  rateLimit.resetRateLimitStore();

  const key = "203.0.113.7";
  for (let i = 1; i <= 3; i += 1) {
    const result = rateLimit.checkRateLimit(key, { limit: 3, windowMs: 60_000 });
    assert.equal(result.ok, true, `第 ${i} 次应放行`);
    assert.equal(result.limit, 3);
    assert.equal(result.remaining, 3 - i);
    assert.equal(result.retryAfterSeconds, 0, "放行时不该建议退避");
  }

  const rejected = rateLimit.checkRateLimit(key, { limit: 3, windowMs: 60_000 });
  assert.equal(rejected.ok, false, "第 4 次必须被拒");
  assert.equal(rejected.remaining, 0);
  assert.ok(rejected.retryAfterSeconds >= 1, "被拒时必须给至少 1 秒的 Retry-After");
  assert.ok(rejected.retryAfterSeconds <= 60, "不能超过窗口长度");
  assert.ok(rejected.resetAt > Date.now(), "resetAt 应在未来");
});

test("限流：不同 key 互不影响", () => {
  rateLimit.resetRateLimitStore();

  rateLimit.checkRateLimit("a", { limit: 1, windowMs: 60_000 });
  const other = rateLimit.checkRateLimit("b", { limit: 1, windowMs: 60_000 });

  assert.equal(other.ok, true, "换了 key 就是新的窗口，不能被别人拖累");
  assert.equal(rateLimit.checkRateLimit("a", { limit: 1, windowMs: 60_000 }).ok, false);
});

test("限流：窗口过期后计数归零", async () => {
  rateLimit.resetRateLimitStore();

  const key = "198.51.100.9";
  assert.equal(rateLimit.checkRateLimit(key, { limit: 1, windowMs: 50 }).ok, true);
  assert.equal(rateLimit.checkRateLimit(key, { limit: 1, windowMs: 50 }).ok, false);

  // 等窗口确实过去（50ms 窗口 + 30ms 余量；用真时钟，不注入时间，避免为此改契约）。
  await new Promise((resolve) => setTimeout(resolve, 80));

  const afterReset = rateLimit.checkRateLimit(key, { limit: 1, windowMs: 50 });
  assert.equal(afterReset.ok, true, "窗口过后必须恢复");
  assert.ok(afterReset.resetAt > Date.now());
});

test("限流：resetRateLimitStore 清空全部计数", () => {
  rateLimit.resetRateLimitStore();

  rateLimit.checkRateLimit("x", { limit: 1, windowMs: 60_000 });
  assert.equal(rateLimit.checkRateLimit("x", { limit: 1, windowMs: 60_000 }).ok, false);

  rateLimit.resetRateLimitStore();
  assert.equal(rateLimit.checkRateLimit("x", { limit: 1, windowMs: 60_000 }).ok, true);
});

test("限流：默认 30 次 / 60 秒", () => {
  rateLimit.resetRateLimitStore();

  for (let i = 0; i < 30; i += 1) {
    assert.equal(rateLimit.checkRateLimit("default-key").ok, true, `第 ${i + 1} 次应放行`);
  }
  const rejected = rateLimit.checkRateLimit("default-key");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.limit, 30);
  assert.ok(rejected.resetAt - Date.now() > 55_000, "默认窗口应为 60 秒");
});

test("限流：clientKeyFromHeaders 三种取值", () => {
  // 1. x-forwarded-for 取第一段（最靠近客户端的那一跳），必须 trim。
  assert.equal(
    rateLimit.clientKeyFromHeaders(
      new Headers({ "x-forwarded-for": "  203.0.113.7 , 70.41.3.18, 150.172.238.178" }),
    ),
    "203.0.113.7",
  );

  // 2. 没有 x-forwarded-for 时退回 x-real-ip。
  assert.equal(
    rateLimit.clientKeyFromHeaders(new Headers({ "x-real-ip": "198.51.100.23" })),
    "198.51.100.23",
  );

  // 3. 两个 header 都没有 → unknown。
  assert.equal(rateLimit.clientKeyFromHeaders(new Headers()), "unknown");

  // 补充：header 存在但为空串时不能返回空 key —— 否则所有空标识会共用一个桶。
  assert.equal(rateLimit.clientKeyFromHeaders(new Headers({ "x-forwarded-for": " , " })), "unknown");
  assert.equal(
    rateLimit.clientKeyFromHeaders(new Headers({ "x-forwarded-for": "", "x-real-ip": "10.0.0.1" })),
    "10.0.0.1",
  );
});
