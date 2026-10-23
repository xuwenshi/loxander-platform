import "server-only";

import { sql } from "drizzle-orm";

import { getAdminDb, hasDatabaseUrl } from "@/lib/admin/db";

/**
 * `/api/health` 的探活逻辑（与 HTTP 层分离）。
 *
 * ── 为什么要和 route.ts 拆开 ──────────────────────────────────────────
 * 本机沙箱禁止子进程（`spawn EPERM`），`next dev` / `next build` 都跑不起来，
 * 想验证「健康检查能反映数据库状态」只能直接调函数。把「查库 + 组装报告」
 * 放进这里、把「定状态码 + 设响应头」留在 route.ts，测试就能在不启动 Next
 * 的前提下覆盖全部三条分支（ok / degraded / down），route.ts 只剩一层
 * 无分支的序列化，风险极低。
 *
 * ── 为什么不用 `"use cache"` ──────────────────────────────────────────
 * 健康检查的**唯一价值**就是反映「此刻」的状态。挂了缓存就等于把一个可能已经
 * 过期的结论当成实时结论报给监控系统 —— 那比没有健康检查更糟，因为监控会
 * 安静地绿着。所以这个模块里一个缓存指令都没有，每次调用都真查一次库。
 *
 * ── 为什么 `sql` 是静态 import 而不是像 lib/sources/db.ts 那样动态 import ──
 * 那边动态 import 是为了让 `CONTENT_SOURCE=markdown` 的部署不把 postgres 拖进
 * 模块图；而本模块**唯一的**调用方是 `/api/health`，它本来就必须连库，
 * 静态 import 不会让任何页面多背一点体积，换来的是类型明确、少一层 await。
 */

/** 探活结论。`degraded` 表示「没法判断」而不是「有问题」，详见下面 checkDatabase 的注释。 */
export type HealthStatus = "ok" | "degraded" | "down";

/** 对外契约。**只有这四个字段**，任何多余字段都会泄露内部信息（方案 §15.2）。 */
export interface HealthReport {
  ok: boolean;
  database: HealthStatus;
  version: string;
  timestamp: string;
}

/**
 * 探活超时上限（毫秒）。
 *
 * 为什么必须有超时：`postgres-js` 建连失败时可能卡在 TCP 握手 / TLS 协商上
 * 几十秒，而健康检查是被监控系统按固定间隔拉的 —— 一个挂住不返回的探针
 * 比返回 503 更糟，它会让监控自己超时、把「数据库慢」误报成「站点挂了」。
 * 3 秒是常见的探针超时档位，也远大于一次 `select 1` 的正常耗时（通常 <10ms）。
 */
const PROBE_TIMEOUT_MS = 3_000;

/** 短 commit sha 的字符数。7 位是 git 的默认短 sha 长度。 */
const SHORT_SHA_LENGTH = 7;

/**
 * 真正打一次库。
 *
 * 用 `select 1` 而不是查业务表：健康检查只关心「连接是否可用、能否执行语句」，
 * 查 `entries` 会把「表结构变更 / 数据为空」这类无关因素掺进来。
 */
async function probeDatabase(): Promise<void> {
  const db = await getAdminDb();
  await db.execute(sql`select 1`);
}

/**
 * 取版本串：优先 Vercel 注入的 commit sha，本地退回 `dev`。
 *
 * 为什么要读两个环境变量：Vercel 部署时自动注入 `VERCEL_GIT_COMMIT_SHA`；
 * 自建 / 本地想带上版本时用 `GIT_COMMIT_SHA`（CI 里 `git rev-parse HEAD` 塞进去）。
 * 都没有就返回 `dev` —— 原文照录，因为「dev」本身就是一个有意义的信息
 * （说明这不是一次可追溯的部署），截断成 `dev` 的最长 7 位反而是同一件事。
 */
function resolveVersion(): string {
  const raw = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "";
  if (raw.length === 0) return "dev";
  return raw.slice(0, SHORT_SHA_LENGTH);
}

/**
 * 执行一次数据库探活。超时或抛错都算 `down`，**绝不抛出**。
 *
 * 三种结论的语义边界（这是本模块最容易搞混的地方）：
 *
 * - `ok`       —— 连上了，`select 1` 执行成功。
 * - `degraded` —— **没有配置数据库**（`DATABASE_URL` 为空）。这不是故障，
 *                 是配置状态：站点可以跑在 `CONTENT_SOURCE=markdown` 模式，
 *                 那种部署本来就不需要库。若把它报成 `down`，每一套纯静态
 *                 部署的监控都会永久性地红着，久而久之没人再看这个接口。
 * - `down`     —— 配了库但连不上 / 超时 / 执行报错。这才是真故障。
 *
 * 为什么不把错误消息放进返回值：健康检查是**可能公开**的端点，错误串里
 * 常见 `postgres://user:pass@host/db` 或主机名 / 端口，直接违反方案 §15.2
 * 「不得在响应中泄露连接串或内部错误细节」。错误只在本进程内被吞掉，
 * 需要排查时看服务端日志。
 */
export async function checkDatabase(): Promise<HealthStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // 没配库是配置状态，不是故障 —— 见上面 degraded 的解释。
    if (!hasDatabaseUrl()) return "degraded";

    // 超时用 Promise.race 而不是给 postgres-js 传 connect_timeout：
    // 那个参数只管「建连」，管不住「连上了但语句卡住」，也管不住
    // 已经有缓存连接时的一次慢查询。race 是在调用方这一层兜底，覆盖面更全。
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`health probe timed out after ${PROBE_TIMEOUT_MS}ms`));
      }, PROBE_TIMEOUT_MS);
    });

    await Promise.race([probeDatabase(), timeout]);
    return "ok";
  } catch {
    // 故意不回传错误对象：见函数注释。这里只关心「可用 / 不可用」。
    return "down";
  } finally {
    // 必须清掉定时器，否则每次探活都会留下一个 3 秒的待办计时器。
    // 健康检查被监控高频拉取时，这会变成真实的句柄泄漏（进程退不干净）。
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 组装完整报告。永不抛错。
 *
 * `ok` 的判定是 `database !== "down"`：`degraded` 仍然算 `ok: true`，
 * 理由同上 —— 没配库的纯静态部署是健康的一种形态。
 */
export async function buildHealthReport(): Promise<HealthReport> {
  const database = await checkDatabase();

  return {
    ok: database !== "down",
    database,
    version: resolveVersion(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * 报告 → HTTP 状态码。
 *
 * 单独抽成函数而不是写在 route.ts 里，是为了让「什么结论配什么状态码」
 * 这条规则可以被测试直接断言，也方便将来加别的状态（比如维护模式）时
 * 只有一处需要改。
 */
export function healthHttpStatus(report: HealthReport): number {
  return report.database === "down" ? 503 : 200;
}
