import "server-only";

/**
 * 极简内存限流器（固定窗口计数）。
 *
 * ── 先说清楚它不是什么 ────────────────────────────────────────────────
 * 这不是 WAF，也不是「防刷」的完整方案。执行方案 P5 的原话就是「基础限流」，
 * 所以这里的定位是：**给接口一个最低成本的兜底**，让一个脚本随手 for 循环
 * 打过来时不至于毫无阻力。真要防刷需要按 IP 段 / 账号维度做策略、需要跨实例
 * 共享计数、需要区分「正常突发」与「恶意扫描」—— 那已经超出 P5 范围。
 *
 * ── 三条必须写明的局限（三条都会在真实流量下暴露） ────────────────────
 *
 * 1. **进程内存储，多实例不共享。**
 *    Vercel 上的每个 Serverless 实例各有一份 `Map`，没有实例间通信。
 *    N 个实例 = 实际放行 N×limit 次。冷启动后计数归零，攻击者只要等一次
 *    冷启动就能把窗口清零重来。生产要换成 Upstash Redis / Vercel KV
 *    这类共享存储（把 `checkRateLimit` 改成 async 即可，接口形状不用变）。
 *
 * 2. **无上限增长，所以必须惰性清理。**
 *    `Map` 的 key 是客户端标识（IP），来源不可控 —— 扫一遍全网 IP 就能把
 *    内存撑爆。所以每次调用时若 `size > SWEEP_THRESHOLD` 就扫一遍删掉已过期
 *    的桶。这不是完美的回收（未过期的大量桶仍会占内存），但把「稳定泄漏」
 *    变成了「窗口长度 × 请求速率」的有界占用，对基础限流够用。
 *    为什么不用 `setInterval` 定时清理：Serverless 里后台定时器不保证执行，
 *    而且会让进程无法自然退出；惰性清理把成本摊到请求路径上，行为确定。
 *
 * 3. **只适合「基础限流」，不能当 WAF。**
 *    它不看请求内容、不做指纹、不区分路径语义、不支持黑名单。它能挡住的
 *    是「同一个 IP 高频打同一个接口」这种最朴素的滥用。
 *
 * ── 为什么加 `import "server-only"` ───────────────────────────────────
 * 这个模块的状态在**进程内存**里。如果哪天有人从前端组件里 import 它，
 * 计数会变成「每个浏览器标签页一份」，限流看起来在工作、实际上完全失效 ——
 * 这种「静默失效」比直接报错危险得多。`server-only` 让误用变成编译期错误。
 */

/** 单桶计数。`resetAt` 是「本窗口结束」的毫秒时间戳。 */
interface Bucket {
  /** 本窗口内已经放行的次数。 */
  count: number;
  /** 窗口重置时刻（`Date.now()` 语义）。 */
  resetAt: number;
}

/** 默认窗口：60 秒。取一分钟是因为它和「每分钟请求数」这个人类直觉单位对齐。 */
const DEFAULT_WINDOW_MS = 60_000;

/** 默认配额：30 次 / 窗口。单人博客量级下，正常浏览远到不了这个数。 */
const DEFAULT_LIMIT = 30;

/**
 * 触发惰性清理的桶数量阈值。
 *
 * 为什么是 5000：单个桶约 80 字节，5000 个约 400KB —— 这个量级对一个
 * Node 进程完全无感，而扫一遍 5000 项的 `Map` 是微秒级，不会造成可观测的
 * 请求延迟。低于这个数量时清理的收益抵不上 CPU 成本，所以干脆不扫。
 */
const SWEEP_THRESHOLD = 5_000;

/** 模块级单例存储。key = 客户端标识，value = 当前窗口的计数。 */
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** 允许下一次请求的毫秒时间戳 */
  resetAt: number;
  /** 被限流时建议的 Retry-After 秒数（未限流为 0） */
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  /** 窗口长度（毫秒），默认 60_000 */
  windowMs?: number;
  /** 窗口内允许的次数，默认 30 */
  limit?: number;
}

/**
 * 惰性清理：桶太多时扫一遍，删掉已经过期的。
 *
 * 只在 `size` 超阈值时才扫，所以正常流量下这个函数是空转的（一次比较）。
 * 用 `for...of` + `delete` 直接改 `Map` 是安全的：删除当前正在遍历的键
 * 在 JS 规范里是明确允许的（后续迭代会跳过它）。
 */
function sweepExpired(now: number): void {
  if (buckets.size <= SWEEP_THRESHOLD) return;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

/**
 * 取客户端标识：优先 `x-forwarded-for` 第一段，退回 `x-real-ip`，都没有则 `"unknown"`。
 *
 * 为什么取 `x-forwarded-for` 的**第一段**：它是「最靠近真实客户端」的那一跳
 * （代理链由左向右追加）。取最后一段拿到的是最近的代理 IP，等于把整条链路
 * 的人合并成同一个桶 —— 一个刷子就能把所有人限死。
 *
 * 为什么要 `trim` 且要判空：某些代理会把 header 写成 `", 1.2.3.4"` 或在逗号后
 * 带空格；空段如果直接返回 `""`，所有「空标识」会共用一个桶（等于又一个
 * 全局桶），所以空段必须当作「没有」继续往下退。
 *
 * 安全提醒：这两个 header 都是**客户端可伪造**的。真正设防时应由可信代理
 * （Vercel 的边缘层）覆盖写入，而不是相信客户端传来的值。这也是「基础限流」
 * 定位下可以接受的取舍。
 */
export function clientKeyFromHeaders(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor !== null) {
    const first = forwardedFor.split(",")[0]?.trim() ?? "";
    if (first.length > 0) return first;
  }

  const realIp = headers.get("x-real-ip")?.trim() ?? "";
  if (realIp.length > 0) return realIp;

  return "unknown";
}

/**
 * 记一次请求并返回判定结果。
 *
 * 固定窗口语义：一个窗口内前 `limit` 次放行，第 `limit + 1` 次开始拒绝，
 * 窗口结束后计数整体归零（不是滑动窗口 —— 滑动窗口需要存每次请求的时间戳，
 * 内存是固定窗口的数倍，对「基础限流」不划算）。
 *
 * 固定窗口的已知缺陷（写在这里免得以后当成 bug）：窗口边界处可能出现
 * 最多 2×limit 次请求「贴着边界」通过。要消除它必须上滑动窗口或令牌桶，
 * 那属于「真限流」的范畴，不在本次范围内。
 */
export function checkRateLimit(key: string, options: RateLimitOptions = {}): RateLimitResult {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const now = Date.now();

  sweepExpired(now);

  const existing = buckets.get(key);

  // 没桶，或窗口已过期 → 开一个新窗口，本次算第 1 次。
  if (existing === undefined || now >= existing.resetAt) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return {
      ok: true,
      limit,
      remaining: Math.max(0, limit - 1),
      resetAt,
      retryAfterSeconds: 0,
    };
  }

  // 窗口还没过，但配额已用尽 → 拒绝，并给出「最快多久能再来」。
  if (existing.count >= limit) {
    return {
      ok: false,
      limit,
      remaining: 0,
      resetAt: existing.resetAt,
      // 向上取整并兜底 1 秒：`Retry-After` 是整秒语义，0 会让客户端立刻重试，
      // 变成「拒绝反而触发更密集的重试」。
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    ok: true,
    limit,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    retryAfterSeconds: 0,
  };
}

/**
 * 仅供测试：清空全部计数。
 *
 * 为什么不导出「删除单个 key」：测试要的是「每个用例从干净状态开始」，
 * 而生产侧如果暴露删除能力，调用方就可能用它绕过限流。少一个 API
 * 就少一条被误用的路。
 */
export function resetRateLimitStore(): void {
  buckets.clear();
}

/**
 * 把「接入点 scope」与「客户端标识」拼成一个桶 key。
 *
 * ── 为什么值得单独收口一个函数 ────────────────────────────────────────
 * 目前有三个接入点（健康检查、后台登录、媒体上传），每一个都要自己决定
 * key 长什么样。若让各处手写 `` `${scope}:${clientKeyFromHeaders(headers)}` ``，
 * 会出现两类静默 bug，而且都不会被 `tsc` 抓到：
 *
 * 1. **前缀写错或漏写**：两处用了同一个前缀 → 两个接口共享一个桶，
 *    打健康检查能把人锁在登录外面。这类 bug 在开发环境几乎复现不出来
 *    （请求量太小），上线后表现为「偶发登录失败」。
 * 2. **忘了先归一化客户端标识**：直接拿 `` headers.get("x-forwarded-for") ``
 *    当 key，会把 `"1.2.3.4, 5.6.7.8"` 整串当标识 —— 同一台机器走不同代理
 *    链就变成不同 key，等于限流被稀释成 N 倍。
 *
 * 收成一个函数之后，「前缀 + 归一化」这条规则只有一份实现，
 * 新增接入点时只要给它一个 scope 就够。
 */
export function rateLimitKey(scope: string, headers: Headers): string {
  return `${scope}:${clientKeyFromHeaders(headers)}`;
}

/*
 * ── 建议接入点（本次只提供能力，不接线；接不接、接哪里由 Lead 决定） ──────
 *
 * 1. `/api/health`（`apps/web/src/app/api/health/route.ts`）
 *    防探测。健康检查会真的打一次库，被外部高频拉取等于帮攻击者做
 *    数据库放大攻击。注意：监控系统也是同一个出口 IP，接入时必须给
 *    监控留白名单或把 limit 调大，否则会把监控自己限死。
 *
 * 2. 后台登录（`apps/web/src/lib/admin/login-actions.ts`）
 *    防撞库。这是最值得接的一处 —— 它对应方案 §15.1 要监控的「登录失败率」。
 *    建议按「IP + 失败次数」计数，而不是无条件按请求数。
 *
 * 3. 媒体上传（`uploadMediaAction`，`apps/web/src/lib/admin/media-actions.ts`）
 *    防存储配额被刷。该 Server Action 由 P5-A 落地（本次并行开发），截至本文件
 *    编写时已存在于 `media-actions.ts:143`，但它不是本次任务的写范围，所以接线
 *    仍留给 Lead 决定。对应方案 §15.1 的监控项「媒体上传失败」。
 */
