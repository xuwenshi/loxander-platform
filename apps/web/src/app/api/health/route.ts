import { buildHealthReport, healthHttpStatus } from "@/lib/health";
import type { HealthReport, HealthStatus } from "@/lib/health";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";

/**
 * `GET /api/health` —— 健康检查端点。
 *
 * 契约（执行方案 §15.2，逐字）：返回
 * `{ "ok": true, "database": "ok", "version": "commit-sha", "timestamp": "..." }`。
 * **不得在响应中泄露连接串或内部错误细节。**
 *
 * ── 这个文件为什么这么薄 ──────────────────────────────────────────────
 * 全部判断都放在 `@/lib/health`，这里只做「调一次 → 定状态码 → 设响应头 →
 * 序列化」。原因很现实：本机沙箱禁止子进程（`spawn EPERM`），`next dev` /
 * `next build` 都起不来，能跑的只有 `node --test`。把分支逻辑留在 route
 * 里就只能靠人眼审；挪进 lib 之后三条分支（ok / degraded / down）都能被
 * 离线测试逐条断言，route 剩下的部分没有分支，出错空间接近零。
 *
 * ── 为什么加 `export const dynamic = "force-dynamic"` ─────────────────
 * 健康检查必须**每次请求都真查一次库**。而 Route Handler 的 GET 默认是
 * 「可以预渲染的」：Next 在构建期会试着跑一次 handler，若它看起来能在
 * 一个 microtask 内返回，结果就会被当成静态响应缓存下来 —— 那意味着一台
 * 已经连不上库的机器，健康检查还在稳定地报 `ok`。对监控来说这是最坏的
 * 情况：它不会报错，它会安静地绿着。
 *
 * 这个项目开了 `cacheComponents: true`，所以必须确认 force-dynamic 在该
 * 模式下合法。实测源码（`node_modules/next/dist/server/route-modules/app-route/module.js`）：
 *
 * - `:172-174`：只有在 `nextConfigOutput === "export"` 时才抛错；本项目没有
 *   `output: export`，所以不会报错。
 * - `:626-634`（`executePrerender` 内的 `switch (prepared.dynamic)`）：`case
 *   "force-dynamic"` 会抛 `DynamicServerError`，于是预渲染阶段直接 bail out，
 *   路由被标记为动态。这正是想要的确定性结果。
 *
 * 为什么**不用** `await connection()`（`admin/layout.tsx:71-80` 里的既有用法）：
 * `connection()` 声明的是「这棵子树要等到请求到达才渲染」，它解决的是**页面**
 * 在 `cacheComponents` 下的 blocking-prerender 问题；对 Route Handler 而言，
 * force-dynamic 已经提供了「不静态化」的语义，而且更直白。更关键的是
 * `connection()` 依赖请求上下文（`workUnitAsyncStorage`），在离线
 * `node --test` 里直接调 `GET()` 时没有那个上下文，行为不确定 —— 会让本可以
 * 离线验证的东西变成只能靠 build 验证，而 build 在沙箱里跑不了。
 *
 * 代价：`migrating-to-cache-components.md:136-138` 那段文档建议「移除
 * force-dynamic」，因为该模式下未缓存的数据访问本来就会在请求时执行。
 * 但那个建议的前提是「Next 能看见这次数据访问」—— 它看见的是 `fetch` /
 * cookies / headers 这类被插桩的 API，而 `postgres-js` 的查询对它是完全
 * 不可见的。对一个看不见的 IO，显式声明就是唯一的保险。所以保留。
 *
 * ── 限流怎么接的，以及两处约定俗成的矛盾怎么调和 ──────────────────────
 * `@/lib/rate-limit` 在这里接上了：健康检查会真的打一次库，被外部高频拉取
 * 等于帮攻击者做「数据库放大攻击」。但接法上必须同时满足两条互相拉扯的要求：
 *
 * - 方案 §15.2：响应体**只许**有 `{ok, database, version, timestamp}` 四个键，
 *   不得泄露连接串或内部错误细节。→ 所以 429 的 body **不加任何字段**
 *   （不加 `error` / `message` / `limit` / `retryAfter`），被限流这件事只能从
 *   状态码和 `Retry-After` 头读出来。
 * - 方案 §15.1：健康检查本身要能被监控。→ 所以必须留一个**白名单门**，
 *   否则监控系统（它和攻击者常常共享同一个出口 IP）会被自己的限流限死，
 *   让「站点挂了」和「监控被限流了」变成同一个现象 —— 那是最坏的失败模式。
 *
 * 白名单：`process.env.HEALTH_RATE_LIMIT_BYPASS_TOKEN` 存在，且请求头
 * `x-health-token` 与它**逐字符相等**时跳过限流。取名上刻意用 `BYPASS`
 * 而不是 `TOKEN`：它不是一个「校验凭据」，而是一道「给自己留的门」。三个
 * 必须知道的后果：
 *
 * 1. 环境变量为空/未设置时，这道门**根本不存在**（空串不等于任何头）。
 *    绝不能写成「没配置就放行」，那样一忘配就等于没有限流。
 * 2. 这个 token 走的是明文 header，会被日志、代理、浏览器历史记录看到。
 *    它只用于「内部监控免限流」，不是鉴权，泄露的后果只是「攻击者也能绕过
 *    限流」—— 所以它不该复用任何真实密钥，建议单独生成一段随机串。
 * 3. 比较用朴素 `===` 而不是恒定时间比较：这里防的是「忘了配」，不是
 *    时序侧信道。真上恒定时间比较会让人误以为这是个安全边界。
 */

export const dynamic = "force-dynamic";

/** 限流窗口：60 秒，与 `lib/rate-limit.ts` 的默认窗口同一量级。 */
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * 默认配额：30 次 / 分钟。
 *
 * 与 `lib/rate-limit.ts` 的 `DEFAULT_LIMIT` 取值相同，但这里**显式写死**而不是
 * 依赖那个默认值：健康检查的配额是一个产品决策（给监控留多少余量），不该
 * 随底层库的默认值悄悄变化。底层库改默认值时，这里不受影响。
 *
 * 为什么是 30：正常监控是 1 次/分钟（Vercel 的 uptime check 最快也就
 * 30 秒一次），30 次留了 30 倍余量；而一个「for 循环打健康检查」的脚本
 * 一秒就能撞上。
 */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;

/** 白名单 token 的环境变量名。 */
const BYPASS_TOKEN_ENV = "HEALTH_RATE_LIMIT_BYPASS_TOKEN";

/** 白名单 token 的请求头名（小写，`Headers.get()` 大小写不敏感）。 */
const BYPASS_HEADER = "x-health-token";

/**
 * 限流 scope。必须是「一个接口一个 scope」，且**不能**与登录/上传等处重名 ——
 * 重名的后果是两个接口共享一个桶，打健康检查会把人锁在登录外面。
 */
const RATE_LIMIT_SCOPE = "health";

/**
 * 读每分钟配额，允许 `HEALTH_RATE_LIMIT_PER_MINUTE` 覆盖。
 *
 * 为什么非法值要「退回默认」而不是「报错」或「放开」：
 * - 报错 → 环境变量写错一个字符就把健康检查打成 500，监控全红；
 * - 放开（比如解析失败当成 Infinity）→ 一个手滑的 `abc` 就等于关掉限流，
 *   而且**静默**关掉，没人会发现。
 * 退回默认是唯一「错了也能自洽」的选项。
 *
 * `Number.parseInt` 而非 `Number`：允许 `"30/min"`、`"30 "` 这种带杂质的写法
 * （parseInt 会读出 30，Number 会给 NaN）。这是环境变量常见的真实形态。
 * `<= 0` 也退回默认 —— 0 或负数配出来等于「一次都不放行」，比不限流更糟。
 */
function resolveRateLimitPerMinute(): number {
  const raw = process.env.HEALTH_RATE_LIMIT_PER_MINUTE;
  if (raw === undefined) return DEFAULT_RATE_LIMIT_PER_MINUTE;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RATE_LIMIT_PER_MINUTE;
  return parsed;
}

/**
 * 判断这次请求是否走白名单免限流。
 *
 * 三个都必须成立：环境变量配了、环境变量非空、请求头逐字符相等。
 * 中间那条（非空）最容易漏：`process.env.X` 未设置时是 `undefined`，
 * 但 `Headers.get()` 拿不到头时返回 `null`，若写成 `token !== header` 就
 * 会变成 `undefined !== null` → `true` → 全部放行。所以这里显式判空。
 *
 * 入参是 `Headers` 而不是 `Request`：调用方（GET）已经先把它从可选的 Request
 * 里取出来了，这里再要求 Request 只会逼调用方多包一层。
 */
function isBypassRequest(headers: Headers): boolean {
  const expected = process.env[BYPASS_TOKEN_ENV];
  if (expected === undefined || expected.length === 0) return false;

  const provided = headers.get(BYPASS_HEADER);
  if (provided === null || provided.length === 0) return false;

  return provided === expected;
}

/**
 * 探活结果**只允许**这四个字段。
 *
 * 这条不是风格问题，是方案 §15.2 的硬要求（「不得在响应中泄露连接串或
 * 内部错误细节」）。常见的翻车方式是「顺手把 error.message 带上，
 * 排查方便」—— 而健康检查往往是唯一一个没有鉴权、被公网直接探测的端点，
 * 错误串里通常就有 `postgres://user:password@host/dbname`。
 *
 * 所以这里显式构造一个新对象、逐字段赋值，而不是把内部对象 spread 出去：
 * 以后 `HealthReport` 加了字段（比如 `uptime`、`region`），也不会自动泄露
 * 到公网响应里 —— 必须有人回来改这个函数，那一步就是评审点。
 */
function toPublicJson(report: HealthReport): {
  ok: boolean;
  database: HealthStatus;
  version: string;
  timestamp: string;
} {
  return {
    ok: report.ok,
    database: report.database,
    version: report.version,
    timestamp: report.timestamp,
  };
}

/**
 * 最近一次成功组装出来的报告。
 *
 * 用途只有一个：被限流（429）时 body 仍要给全四个键，而**不能**为此再打一次库 ——
 * 限流存在的意义就是「别让高频请求打到数据库」，若 429 分支里再 probe 一次，
 * 等于把放大攻击完整保留下来，限流只是多返回了一个状态码。
 *
 * 所以 429 时 `database` / `version` 用「上一次可判定的值」，`ok` 恒为 false
 * （这一次我们确实没能给出实时结论）。这也正是 lead 在任务里给的写法。
 *
 * 为什么这里可以接受一份「可能过期的状态」：429 的语义是「你问得太勤了」，
 * 不是「服务异常」。真正的状态判定仍由下一条被放行的请求给出。
 *
 * 真实情况下这个变量在本进程第一次返回 429 之前必定已被赋值 ——
 * 配额至少是 1，第一条请求必然放行并写入它。兜底值只是为了让类型收窄。
 */
let lastReport: HealthReport | null = null;

/*
 * 为什么 `request` 是**可选**参数：
 *
 * Next 永远会传 Request 进来，但「健康检查」的核心语义是「此刻服务能不能用」，
 * 与调用方是谁无关。单元测试里大量 `route.GET()` 直接调用，如果签名强制要求
 * Request，那些用例要么全部改成伪造 Request（噪声远大于收益），要么被迫去
 * 断言与本次改动无关的东西。
 *
 * 省略 Request 时退化成 `new Headers()`：此时 clientKeyFromHeaders() 返回
 * "unknown"，所有无参调用共享同一个桶 —— 这在测试里正是想要的效果（相互隔离
 * 靠 resetRateLimitStore()），而生产路径永远走真实的 Request。
 */
export async function GET(request?: Request): Promise<Response> {
  const requestHeaders = request?.headers ?? new Headers();

  // 白名单先判：监控系统与攻击者常共享出口 IP，不给自己留门就会把监控限死，
  // 让「站点挂了」和「监控被限流了」变成同一个现象（见文件头注释）。
  if (!isBypassRequest(requestHeaders)) {
    const limited = checkRateLimit(rateLimitKey(RATE_LIMIT_SCOPE, requestHeaders), {
      windowMs: RATE_LIMIT_WINDOW_MS,
      limit: resolveRateLimitPerMinute(),
    });

    if (!limited.ok) {
      // 关键：body **只许**四个键（方案 §15.2）。不写 `error` / `message` /
      // `limit` / `retryAfter`，被限流这件事只能从状态码 + Retry-After 读。
      const stale = lastReport;
      const body = {
        ok: false,
        // 沿用上一次可判定的状态；从没探活过（理论上不可达）就报 down ——
        // 宁可保守地把「不知道」说成故障，也不要谎报健康。
        database: stale?.database ?? ("down" as HealthStatus),
        version: stale?.version ?? "dev",
        timestamp: new Date().toISOString(),
      };

      const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        // 必须带且必须是正整数秒：客户端（和 Vercel 的边缘）据此退避。
        "Retry-After": String(Math.max(1, Math.ceil(limited.retryAfterSeconds))),
      });

      return new Response(JSON.stringify(body), { status: 429, headers });
    }
  }

  // buildHealthReport 内部已经吞掉所有异常，这里不需要 try/catch ——
  // 健康检查自己绝不能 500 到连 JSON 都不返回，否则监控拿到的是 HTML 错误页。
  const report = await buildHealthReport();
  lastReport = report;
  const status = healthHttpStatus(report);

  const headers = new Headers({
    // 显式带 charset：`application/json` 的默认字符集在 RFC 里是 UTF-8，
    // 但部分老旧监控 / 代理会按 ISO-8859-1 处理，带上更保险。
    "Content-Type": "application/json; charset=utf-8",
    // 三重防缓存：no-store 给浏览器与中间层，max-age=0 兜住只认 max-age 的
    // 老缓存，必须每次回源。
    "Cache-Control": "no-store, max-age=0",
  });

  if (status === 503) {
    // 只在故障时给 Retry-After。10 秒是一个折中：足够让客户端退避，
    // 又短到数据库恢复后监控能较快转为绿。成功响应上带这个头没有意义，
    // 反而会诱导客户端「成功之后也要等」。
    headers.set("Retry-After", "10");
  }

  return new Response(JSON.stringify(toPublicJson(report)), { status, headers });
}
