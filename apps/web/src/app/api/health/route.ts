import { connection } from "next/server";

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
 * ── 为什么用 `await connection()` 而不是 `export const dynamic` ────────
 * 健康检查必须**每次请求都真查一次库**。而 Route Handler 的 GET 在
 * `cacheComponents` 下和页面同一套模型：**不访问未缓存数据或请求期数据时
 * 会被预渲染**（`migrating-to-cache-components.md:829`，逐字：
 * "With Cache Components, `GET` handlers follow the same model as pages:
 * they prerender when they don't access uncached or runtime data"）。
 * 一旦被预渲染，一台已经连不上库的机器，健康检查还在稳定地报 `ok` ——
 * 对监控来说这是最坏的失败模式：它不会报错，它会安静地绿着。
 *
 * 这里原先写的是 `export const dynamic = "force-dynamic"`，**在 dev 下直接
 * 报错**（实测 2026-10-23，`GET /api/health` → 500）：
 *
 *   Module build failed ... next-swc-loader.js:
 *   Error: Route segment config "dynamic" is not compatible with
 *   `nextConfig.cacheComponents`. Please remove it.
 *
 * 即 `dynamic` 这个 segment config 在 `cacheComponents: true` 下已被禁用，
 * 不是「不推荐」而是**硬报错**。上一版注释里「源码 `module.js:626-634` 的
 * force-dynamic 分支会抛 DynamicServerError」那段推断因此作废 —— 那条分支
 * 在本项目的配置下根本走不到，编译阶段就被拦下了。这是「只靠读源码、没有
 * 真跑一次」的典型误判，留在这里当教训。
 *
 * 正确做法是文档给的那条（`connection.md`「Good to know」+ 迁移指南
 * `:136-138`）：删掉 segment config，改用运行期信号。`connection()` 的语义
 * 逐字是「rendering should wait for an incoming user request before
 * continuing」，实测源码（`node_modules/next/dist/server/request/connection.js`）：
 * - `:61-66` `case 'prerender' | 'prerender-client' | 'prerender-runtime'`：
 *   返回 `makeDynamicHangingPromise(...)` —— 预渲染在此处**永远挂住**，
 *   于是整个路由退出预渲染，被标记为动态。这正是想要的确定性结果。
 * - `:78-92` `case 'request'`：走 `trackDynamicDataInDynamicRender()` 后
 *   返回 `asyncApiPromises.connection`（或 dev 下的 devtools promise），
 *   真实请求下立即 resolve，不增加延迟。
 *
 * 为什么不用 `io()`（文档对 cacheComponents 的首选）：`io()` 的语义是
 * 「接下来有一次 IO，别把它塞进静态壳」，它允许**被缓存**（放在 `use cache`
 * 里会变成 no-op 并把值固化进静态壳）。健康检查恰恰要「永不被缓存」，
 * `connection()` 的「等真实请求」才是精确的那个词。
 *
 * 代价（必须知道）：`connection()` 依赖请求上下文
 * （`workUnitAsyncStorage`），离线 `node --test` 里直接调 `GET()` 没有那个
 * 上下文，`connection.js:98-101` 会走 `throwForMissingRequestStore()` 抛
 * "`connection` was called outside a request scope"。所以
 * `route.test.ts` 把 `next/server` 打桩成 `connection: async () => {}`
 * （见该文件第 2 条打桩说明）。这是**唯一**为了可测性做的让步，
 * 换来的是「预渲染行为由框架保证」而不是「由我读源码推断」。
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
 *
 * ── 注意：这里**不能**写 `export const dynamic` ──────────────────────
 * 它在 `cacheComponents: true` 下是硬报错（不是不推荐），dev 下直接 500。
 * 详见文件头「为什么用 `await connection()` 而不是 `export const dynamic`」。
 */

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
 * 为什么参数是**必填**的 `Request`（而不是 `request?: Request`）：
 *
 * Next 会为每个 Route Handler 生成类型检查（`.next/dev/types/app/api/health/route.ts`），
 * 里面把第一个参数约束成 `NextRequest | Request`。写成可选参数会直接编译失败：
 *
 *   Type '{ __tag__: "GET"; __param_position__: "first";
 *          __param_type__: Request | undefined; }'
 *   does not satisfy the constraint 'ParamCheck<NextRequest | Request>'
 *
 * 这个错误只在 `.next` 存在时出现（tsconfig 的 include 里有 `.next/types` 下的生成文件），
 * 所以「清掉 .next 再跑 tsc 是绿的」是个假象 ——
 * 真实部署前一定会有 .next。上一版为了「单元测试里能 route.GET()」而写成可选，
 * 换来的就是这条只在有构建产物时才暴露的错。宁可让测试多传一个 Request。
 *
 * 运行时容错仍然保留：`request?.headers ?? new Headers()` 对 `undefined` 也成立，
 * 所以旧调用方（含任何直接 `route.GET()` 的脚本）不会炸，只是类型层面要求传。
 */
export async function GET(request: Request): Promise<Response> {
  // 必须放在第一行：预渲染阶段这里会永远挂住（见文件头「为什么用 connection()」），
  // 于是整条路由退出预渲染、被标记为动态。放到限流判断之后也能生效，
  // 但那样限流器会在构建期被调用一次（往进程内的桶里记一笔），属于无谓的副作用。
  await connection();

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
