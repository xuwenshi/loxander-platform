/**
 * P5-B 限流接线的离线验收（不需要 Next 起服务，不需要真库）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 * P5 交付的 `lib/rate-limit.ts` 是一个**纯能力**：一个 Map、两个函数，
 * 单独看全绿。但它的价值完全取决于「有没有真的接到入口上」，而接错的方式
 * 全都不会让 `tsc` 报错，也全都只有真跑请求才看得见：
 *
 * - 阈值配反（把 30 写成了 3000）；
 * - 白名单判空写错（`undefined !== null` → 全员放行）；
 * - 429 的 body 顺手带上 `error` / `limit`，泄露内部细节（违反方案 §15.2）；
 * - 忘了 `Retry-After`，客户端立刻重试，拒绝反而放大请求量；
 * - 两个入口用了同一个 scope，打健康检查能把人锁在登录外面；
 * - 登录 action 里用 `redirect()` 而不是抛错 —— 用户看不到「太频繁」。
 *
 * 本机沙箱禁止子进程（`spawn EPERM`），`next dev` / `next build` 都跑不起来，
 * Playwright 无从谈起。所以这里退到「直接调 route handler / Server Action」，
 * 把上述每一条变成断言。
 *
 * ── 三个必须打桩的东西 ────────────────────────────────────────────────
 * 1. `server-only` → 空模块（真实包在非 RSC 环境会直接抛错）。
 * 2. `next/headers` → 一个返回**可控** `Headers` 的替身。登录 action 要用它
 *    取客户端标识，纯 node 里没有请求上下文，真实现必抛。
 *    用 `data:` URL 模块实现，**不落盘** —— 这样本次改动仍然只有四个文件，
 *    不会为了测试多出一个 stub 文件。
 * 3. `../auth` → 替身 `signIn`。真实现会走 OAuth 往返并抛 `NEXT_REDIRECT`，
 *    而本测试只关心「限流在不在 signIn 之前生效」。
 *
 * 另外 `db/` 下的相对 import 没有扩展名（`from "../../../../../db/schema"`），
 * 纯 node 解析不到，必须在 resolve 钩子里补 `.ts`（与 `p5-wiring.test.ts` 同款）。
 *
 * 跑法：`node --test-isolation=none apps/web/src/lib/__tests__/rate-limit-wiring.test.ts`
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `apps/web/src`（本文件在 `src/lib/__tests__/` 下，往上两层）。 */
const SRC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
/** `apps/web`。 */
const WEB_DIR = resolvePath(SRC_DIR, "..");
/** 仓库根 `loxander-platform`。 */
const REPO_DIR = resolvePath(WEB_DIR, "..", "..");

const SERVER_ONLY_EMPTY = resolvePath(REPO_DIR, "node_modules/server-only/empty.js");

/**
 * `next/server` 替身（data: URL，不落盘）。
 *
 * 两个作用：
 * 1. **让测试能加载 `route.ts`**。`next` 的 package.json 没有 `exports` 字段，
 *    纯 node 下 `import("next/server")` 直接 `ERR_MODULE_NOT_FOUND`；
 *    不替换成替身，整个测试连 import 阶段都过不去。
 * 2. **让 `connection()` 退化成 no-op**。真实实现在没有请求上下文时会抛
 *    `` `connection` was called outside a request scope ``（见
 *    `next/dist/server/request/connection.js:98-101`），
 *    而在预渲染阶段它会返回一个永远挂住的 Promise。测试里两者都不需要，
 *    我们关心的是限流逻辑，不是渲染调度。
 */
const NEXT_SERVER_STUB_URL = `data:text/javascript,${encodeURIComponent(
  ["export async function connection() {", "  return undefined;", "}"].join("\n"),
)}`;

/**
 * `next/headers` 替身（data: URL，不落盘）。
 *
 * 返回 `globalThis.__P5_STUB_HEADERS__`，测试可以随时改写它来模拟不同的
 * `x-forwarded-for` / `x-health-token`。用全局变量而不是模块导出，是因为
 * data: URL 模块之间无法互相 import —— 只能借 `globalThis` 传值。
 */
const NEXT_HEADERS_STUB_URL = `data:text/javascript,${encodeURIComponent(
  "export function headers(){ return globalThis.__P5_STUB_HEADERS__ ?? new Headers(); }",
)}`;

/**
 * `../auth` 替身（data: URL，不落盘）。
 *
 * `signIn` 只往 `globalThis.__P5_SIGN_IN_CALLS__` 里记一笔就抛错 —— 模拟真实
 * 的 `NEXT_REDIRECT`（真实实现一定会抛，不会正常返回）。这样测试能区分
 * 「限流放行后走到了 signIn」与「被限流挡住、根本没到 signIn」。
 */
const AUTH_STUB_URL = `data:text/javascript,${encodeURIComponent(
  "export async function signIn(){ (globalThis.__P5_SIGN_IN_CALLS__ ??= []).push(1); throw new Error(\"NEXT_REDIRECT\"); }",
)}`;

declare global {
  // eslint-disable-next-line no-var
  var __P5_STUB_HEADERS__: Headers | undefined;
  // eslint-disable-next-line no-var
  var __P5_SIGN_IN_CALLS__: number[] | undefined;
}

/** `lib/admin` 的绝对路径，用来判断 `../auth` 是哪个文件发出的。 */
const ADMIN_DIR = resolvePath(SRC_DIR, "lib/admin");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: pathToFileURL(SERVER_ONLY_EMPTY).href, shortCircuit: true };
    }

    if (specifier === "next/server") {
      return { url: NEXT_SERVER_STUB_URL, shortCircuit: true };
    }

    if (specifier === "next/headers") {
      return { url: NEXT_HEADERS_STUB_URL, shortCircuit: true };
    }

    // 只有 `lib/admin/*` 发出的 `../auth` 才换成替身。其它路径的 `../auth`
    // （如果有）保持原样，避免误伤。
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : "";
    if (specifier === "../auth" && parent.startsWith(ADMIN_DIR)) {
      return { url: AUTH_STUB_URL, shortCircuit: true };
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
      const parentFile = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
      const bare = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
      const target = resolvePath(dirname(parentFile), bare);
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(target + ext)) {
          return { url: pathToFileURL(target + ext).href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
});

// `db/mapping.ts` 等旧模块用 `path.join(process.cwd(), ...)` 找内容目录，
// 站点的运行时 cwd 是 `apps/web`，测试里必须切过去（保持与既有测试一致）。
process.chdir(WEB_DIR);

import { test } from "node:test";
import assert from "node:assert/strict";

const rateLimit = await import("../rate-limit");
const healthRoute = await import("../../app/api/health/route");
const loginActions = await import("../admin/login-actions");

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

/** 限流相关的两个环境变量。每个用例前后都要还原，否则会串味。 */
const ENV_BYPASS = "HEALTH_RATE_LIMIT_BYPASS_TOKEN";
const ENV_LIMIT = "HEALTH_RATE_LIMIT_PER_MINUTE";

interface EnvSnapshot {
  bypass: string | undefined;
  limit: string | undefined;
}

function snapshotEnv(): EnvSnapshot {
  return { bypass: process.env[ENV_BYPASS], limit: process.env[ENV_LIMIT] };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  // 注意：`process.env.X = undefined` 会把值写成字符串 "undefined"，
  // 必须用 `delete` 才是「未设置」。
  if (snapshot.bypass === undefined) delete process.env[ENV_BYPASS];
  else process.env[ENV_BYPASS] = snapshot.bypass;

  if (snapshot.limit === undefined) delete process.env[ENV_LIMIT];
  else process.env[ENV_LIMIT] = snapshot.limit;
}

/**
 * 每个用例开始前的统一清理。
 *
 * 三件事缺一不可：
 * 1. `resetRateLimitStore()` —— 计数是模块级 Map，不清会跨用例累加；
 * 2. 还原环境变量 —— 上一个用例设的 `HEALTH_RATE_LIMIT_PER_MINUTE=3`
 *    会让下一个用例在第 4 次就 429，表现为「随机失败」；
 * 3. 清空 `signIn` 调用记录 —— 用来断言「限流挡住了，没走到 signIn」。
 */
function resetAll(): void {
  rateLimit.resetRateLimitStore();
  delete process.env[ENV_BYPASS];
  delete process.env[ENV_LIMIT];
  globalThis.__P5_SIGN_IN_CALLS__ = [];
  globalThis.__P5_STUB_HEADERS__ = undefined;
}

/** 造一个发往健康检查的 GET 请求。`headers` 缺省为空（客户端标识退化成 "unknown"）。 */
function healthRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/health", { headers: headers ?? {} });
}

/** 读响应体 JSON，并同时返回键名（用来断言「只有四个键」）。 */
async function readJson(response: Response): Promise<{ body: Record<string, unknown>; keys: string[] }> {
  const body = (await response.json()) as Record<string, unknown>;
  return { body, keys: Object.keys(body).sort() };
}

/* -------------------------------------------------------------------------- */
/* 1. 健康检查：阈值与 429 的形状                                              */
/* -------------------------------------------------------------------------- */

test("限流接线 / 健康检查：默认配额 30 次内 200，第 31 次 429", async () => {
  resetAll();

  // 前 30 次必须全部放行。这里逐次断言而不是只数总数，是为了在失败时
  // 直接看出「第几次开始 429」—— 若配置被改成 20，第 21 次就会红。
  for (let i = 1; i <= 30; i += 1) {
    const response = await healthRoute.GET(healthRequest());
    assert.equal(response.status, 200, `第 ${i} 次请求应该放行`);
  }

  const blocked = await healthRoute.GET(healthRequest());
  assert.equal(blocked.status, 429, "第 31 次请求必须被限流");
});

test("限流接线 / 健康检查：429 的 body 只有 ok/database/version/timestamp 四个键", async () => {
  resetAll();

  for (let i = 1; i <= 30; i += 1) await healthRoute.GET(healthRequest());
  const blocked = await healthRoute.GET(healthRequest());
  assert.equal(blocked.status, 429);

  const { keys } = await readJson(blocked);

  // 方案 §15.2 的硬契约：不得泄露连接串或内部错误细节。
  // 顺序无关，用 sort 后的数组比对，多一个键少一个键都会红。
  // 特别注意：不许多出 `error` / `message` / `limit` / `retryAfter` ——
  // 「顺手带上方便排查」是本项目最典型的翻车方式。
  assert.deepEqual(keys, ["database", "ok", "timestamp", "version"]);
});

test("限流接线 / 健康检查：429 带 Retry-After 头，且是正整数秒", async () => {
  resetAll();

  for (let i = 1; i <= 30; i += 1) await healthRoute.GET(healthRequest());
  const blocked = await healthRoute.GET(healthRequest());
  assert.equal(blocked.status, 429);

  const retryAfter = blocked.headers.get("Retry-After");
  assert.notEqual(retryAfter, null, "429 必须带 Retry-After，否则客户端会立刻重试");

  const seconds = Number.parseInt(retryAfter as string, 10);
  assert.ok(Number.isInteger(seconds), `Retry-After 必须是整数秒，实际是 ${String(retryAfter)}`);
  assert.ok(seconds >= 1, `Retry-After 必须 >= 1，实际是 ${seconds}`);
  // 窗口是 60 秒，所以建议值不可能超过 60。
  assert.ok(seconds <= 60, `Retry-After 不应超过窗口长度 60，实际是 ${seconds}`);

  // 429 同样不能缓存，否则中间层会替我们「一直拒绝」。
  assert.match(blocked.headers.get("Cache-Control") ?? "", /no-store/);
});

test("限流接线 / 健康检查：200 的 body 也只有那四个键", async () => {
  resetAll();

  const { body, keys } = await readJson(await healthRoute.GET(healthRequest()));
  assert.deepEqual(keys, ["database", "ok", "timestamp", "version"]);

  // 本机没有 DATABASE_URL。`lib/health.ts:99` 明确写着「没配库是配置状态，
  // 不是故障」→ 返回 degraded；`healthHttpStatus` 只把 down 判成 503。
  // 所以这里的正确断言是 degraded + 200，而不是 down + 503。
  assert.equal(body.database, "degraded", "无 DATABASE_URL 时 checkDatabase 返回 degraded（已读 lib/health.ts:94-120 确认，不抛错）");
  assert.equal(body.ok, true);
});

/* -------------------------------------------------------------------------- */
/* 2. 健康检查：监控白名单                                                     */
/* -------------------------------------------------------------------------- */

test("限流接线 / 健康检查：带正确 x-health-token 时连续 50 次都不被限", async () => {
  resetAll();
  const snapshot = snapshotEnv();

  try {
    process.env[ENV_BYPASS] = "s3cret-monitor-token";

    // 远超 30 次配额。若白名单失效，第 31 次就会 429 → 监控自己被限死。
    for (let i = 1; i <= 50; i += 1) {
      const response = await healthRoute.GET(healthRequest({ "x-health-token": "s3cret-monitor-token" }));
      assert.equal(response.status, 200, `白名单请求第 ${i} 次应该放行`);
    }

    // 而且白名单请求不应该消耗任何计数：紧接着用「无 token」的请求打 30 次，
    // 应该仍然全部放行（说明白名单路径根本没进 checkRateLimit）。
    for (let i = 1; i <= 30; i += 1) {
      const response = await healthRoute.GET(healthRequest());
      assert.equal(response.status, 200, `白名单不该占用普通桶，第 ${i} 次普通请求应放行`);
    }
  } finally {
    restoreEnv(snapshot);
  }
});

test("限流接线 / 健康检查：token 错误时仍然被限（白名单不可绕过）", async () => {
  resetAll();
  const snapshot = snapshotEnv();

  try {
    process.env[ENV_BYPASS] = "s3cret-monitor-token";

    for (let i = 1; i <= 30; i += 1) {
      await healthRoute.GET(healthRequest({ "x-health-token": "wrong-token" }));
    }

    const blocked = await healthRoute.GET(healthRequest({ "x-health-token": "wrong-token" }));
    assert.equal(blocked.status, 429, "错误的 token 必须照常被限，不能因为「带了头」就放行");

    // 另外一个常见写法陷阱：环境变量没配时，`undefined !== null` 恒为 true。
    // 这里把变量删掉，再带同一个头 —— 仍然必须被限。
    delete process.env[ENV_BYPASS];
    rateLimit.resetRateLimitStore();

    for (let i = 1; i <= 30; i += 1) {
      await healthRoute.GET(healthRequest({ "x-health-token": "s3cret-monitor-token" }));
    }
    const blocked2 = await healthRoute.GET(healthRequest({ "x-health-token": "s3cret-monitor-token" }));
    assert.equal(blocked2.status, 429, "未配置 bypass 变量时不允许任何人绕过限流");
  } finally {
    restoreEnv(snapshot);
  }
});

test("限流接线 / 健康检查：HEALTH_RATE_LIMIT_PER_MINUTE 覆盖生效", async () => {
  resetAll();
  const snapshot = snapshotEnv();

  try {
    process.env[ENV_LIMIT] = "3";

    for (let i = 1; i <= 3; i += 1) {
      const response = await healthRoute.GET(healthRequest());
      assert.equal(response.status, 200, `配额 3 时第 ${i} 次应放行`);
    }

    const blocked = await healthRoute.GET(healthRequest());
    assert.equal(blocked.status, 429, "配额 3 时第 4 次必须 429");
  } finally {
    restoreEnv(snapshot);
  }

  // 非法值必须退回默认（30），而不是报错或放开。
  resetAll();
  const snapshot2 = snapshotEnv();
  try {
    process.env[ENV_LIMIT] = "abc";
    for (let i = 1; i <= 30; i += 1) {
      const response = await healthRoute.GET(healthRequest());
      assert.equal(response.status, 200, `非法配额应退回 30，第 ${i} 次应放行`);
    }
    const blocked = await healthRoute.GET(healthRequest());
    assert.equal(blocked.status, 429, "非法配额退回 30 后，第 31 次必须 429");
  } finally {
    restoreEnv(snapshot2);
  }
});

/* -------------------------------------------------------------------------- */
/* 3. 登录 action                                                              */
/* -------------------------------------------------------------------------- */

test("限流接线 / 登录：连续 10 次后第 11 次抛错，且信息含「过于频繁」", async () => {
  resetAll();

  // 前 10 次应该「放行」到 signIn。signIn 替身会抛 NEXT_REDIRECT，
  // 所以每次都要 catch —— 抛出的错误正是「走到了 signIn」的证据。
  for (let i = 1; i <= 10; i += 1) {
    await assert.rejects(
      () => loginActions.signInWithGitHubAction(),
      /NEXT_REDIRECT/,
      `第 ${i} 次登录应放行到 signIn`,
    );
  }

  assert.equal(globalThis.__P5_SIGN_IN_CALLS__?.length, 10, "前 10 次都应真的调用到 signIn");

  // 第 11 次必须被限流挡住：抛的是受控错误，**不是** NEXT_REDIRECT。
  await assert.rejects(
    () => loginActions.signInWithGitHubAction(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /过于频繁/, `错误信息应提示「过于频繁」，实际是：${error.message}`);
      assert.doesNotMatch(error.message, /NEXT_REDIRECT/, "被限流时不应该走到 signIn");
      return true;
    },
  );

  assert.equal(
    globalThis.__P5_SIGN_IN_CALLS__?.length,
    10,
    "被限流后不能再调用 signIn（限流必须发生在 signIn 之前）",
  );
});

test("限流接线 / 登录：5 分钟窗口比健康检查更严，且两个 scope 互不干扰", async () => {
  resetAll();

  // 打满 30 次健康检查（健康检查的配额）——
  for (let i = 1; i <= 30; i += 1) await healthRoute.GET(healthRequest());
  assert.equal((await healthRoute.GET(healthRequest())).status, 429, "健康检查应已被限流");

  // 此时登录**不应该**受影响：两者用不同 scope，桶必须隔离。
  // 若有人把 scope 写重复了，这里第 1 次登录就会直接抛「过于频繁」。
  await assert.rejects(() => loginActions.signInWithGitHubAction(), /NEXT_REDIRECT/, "登录不应被健康检查的限流连带");

  // 反过来也验一遍：把登录配额打满，健康检查仍然可用。
  rateLimit.resetRateLimitStore();
  for (let i = 1; i <= 10; i += 1) {
    await assert.rejects(() => loginActions.signInWithGitHubAction(), /NEXT_REDIRECT/);
  }
  await assert.rejects(() => loginActions.signInWithGitHubAction(), /过于频繁/);

  const healthStillOk = await healthRoute.GET(healthRequest());
  assert.equal(healthStillOk.status, 200, "登录被限流不应影响健康检查");
});

test("限流接线 / 登录：客户端标识来自请求头，不同 IP 是不同的桶", async () => {
  resetAll();

  // 先让 A 把配额打满。
  globalThis.__P5_STUB_HEADERS__ = new Headers({ "x-forwarded-for": "203.0.113.7" });
  for (let i = 1; i <= 10; i += 1) {
    await assert.rejects(() => loginActions.signInWithGitHubAction(), /NEXT_REDIRECT/);
  }
  await assert.rejects(() => loginActions.signInWithGitHubAction(), /过于频繁/, "A 应已被限流");

  // 换一个 IP（x-forwarded-for 第一段）→ 全新的桶，应该立刻放行。
  globalThis.__P5_STUB_HEADERS__ = new Headers({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" });
  await assert.rejects(
    () => loginActions.signInWithGitHubAction(),
    /NEXT_REDIRECT/,
    "另一个 IP 不应被 A 的限流影响；这也顺带验证 x-forwarded-for 只取第一段",
  );
});

/* -------------------------------------------------------------------------- */
/* 4. 存储重置                                                                 */
/* -------------------------------------------------------------------------- */

test("限流接线：resetRateLimitStore() 之后计数归零", async () => {
  resetAll();

  for (let i = 1; i <= 30; i += 1) await healthRoute.GET(healthRequest());
  assert.equal((await healthRoute.GET(healthRequest())).status, 429, "先确认已经被限流");

  rateLimit.resetRateLimitStore();

  const afterReset = await healthRoute.GET(healthRequest());
  assert.equal(afterReset.status, 200, "重置后应重新放行");
});

/* -------------------------------------------------------------------------- */
/* 5. rateLimitKey 本身                                                        */
/* -------------------------------------------------------------------------- */

test("限流接线：rateLimitKey 统一「scope:客户端标识」，并归一化代理链", () => {
  resetAll();

  // 没有代理头 → "unknown"。
  assert.equal(rateLimit.rateLimitKey("health", new Headers()), "health:unknown");

  // 取 x-forwarded-for 第一段，不是整串。整串会让「同一台机器走不同代理链」
  // 变成不同 key，等于限流被稀释成 N 倍。
  assert.equal(
    rateLimit.rateLimitKey("login", new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })),
    "login:203.0.113.7",
  );

  // 退回 x-real-ip。
  assert.equal(rateLimit.rateLimitKey("media-upload", new Headers({ "x-real-ip": "192.0.2.5" })), "media-upload:192.0.2.5");

  // 同一个客户端、不同 scope → 不同 key（这是防「跨入口共享桶」的唯一机制）。
  const h = new Headers({ "x-forwarded-for": "203.0.113.7" });
  assert.notEqual(rateLimit.rateLimitKey("health", h), rateLimit.rateLimitKey("login", h));
});
