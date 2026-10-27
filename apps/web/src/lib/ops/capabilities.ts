import "server-only";

/**
 * 运维台的**能力声明表**（唯一真相来源）。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────
 * 运维台要做的事分三类，而这三类在运行时的可行性**完全不同**：
 *
 *   1. 读数据库结构/数据/迁移状态   → 任何环境都能做（有 DATABASE_URL 就行）
 *   2. 跑脚本（preflight / 测试 / 回滚演练） → 需要 `child_process`，**Vercel 上必然失败**
 *   3. 备份恢复                      → 恢复是写库，与「只读」权限冲突
 *
 * 如果不把这件事显式建模，界面就只能「点了没反应」或「线上点了报 500」——
 * 用户会以为功能坏了，而实际是**环境不支持**。所以每个能力都带
 * `availability`，页面按它渲染成「可点 / 灰掉并说明原因」。
 *
 * ── spawn 不可用这件事是实测的，不是猜的 ─────────────────────────────
 * 本机沙箱 `spawn('node', [...])` 直接抛 `Error: spawn EPERM`（errno -4048）。
 * Vercel 的 Serverless/Edge 运行时同样不提供子进程。所以第 2 类能力
 * **不能**用 `child_process` 实现，必须改成「进程内 import 那个模块并调用」。
 * 详见 `lib/ops/runner.ts` 的注释。
 */

/** 某个能力在**当前环境**能不能真的执行。 */
export type CapabilityAvailability =
  /** 当前环境可以直接执行。 */
  | "available"
  /** 当前环境缺少必要条件（如没有凭据），附原因。 */
  | "unavailable"
  /** 出于安全策略**主动禁用**，不是环境问题。 */
  | "disabled";

/** 一个可执行动作的声明。 */
export interface Capability {
  /** 稳定 id，用于 URL 参数与审计 `detail.action`。 */
  id: string;
  /** 展示名。 */
  label: string;
  /** 一句话说明它做什么。 */
  description: string;
  /** 分组，页面按组渲染。 */
  group: "database" | "script" | "test" | "runtime" | "export" | "env";
  /** 当前环境可用性。 */
  availability: CapabilityAvailability;
  /** `availability !== "available"` 时必填，直接展示给用户看的原因。 */
  reason?: string;
  /** 预计耗时档位，用于在按钮旁提示「这个要等一会儿」。 */
  cost: "instant" | "seconds" | "minutes";
  /** 是否会产生副作用（写库/写文件）。只读动作为 false。 */
  mutates: boolean;
}

/** 当前进程是否运行在 Vercel 上。 */
export function isVercelRuntime(): boolean {
  return process.env.VERCEL === "1" || process.env.VERCEL === "true";
}

/** 当前进程是否处于生产构建（`next start` / 线上）。 */
export function isProductionBuild(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * 「能否在进程内跑一个原本是 CLI 的模块」。
 *
 * 三个条件缺一不可：
 * - 不是 Vercel（serverless 无持久文件系统，且部分模块会读 `content/` 目录）；
 * - 有仓库源码（生产部署只有 `.next` 产物，没有 `db/`、`scripts/` 源码）；
 * - 允许通过环境变量显式打开（默认关，避免线上误触）。
 */
export function canRunRepoScripts(): boolean {
  if (isVercelRuntime()) return false;
  if (process.env.OPS_ALLOW_SCRIPTS !== "1") return false;
  return true;
}

/**
 * 为什么不能跑脚本。返回值直接展示给用户，所以必须说人话。
 *
 * 顺序有意义：先报「环境根本不可能」，再报「需要显式开启」。
 */
export function scriptsUnavailableReason(): string {
  if (isVercelRuntime()) {
    return "线上运行时不提供子进程与仓库源码，脚本只能在你的本机跑。";
  }
  if (process.env.OPS_ALLOW_SCRIPTS !== "1") {
    return "为避免误触，脚本执行默认关闭。在 .env 里设 OPS_ALLOW_SCRIPTS=1 后重启即可启用。";
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/* 能力清单                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 构建能力清单。
 *
 * 注意 `mutates` 字段：本运维台的设计前提是**数据库只读**（用户明确选择），
 * 所以数据库相关的动作里只有「备份导出」是允许的，恢复被显式标成 disabled。
 */
export function buildCapabilities(): Capability[] {
  const scriptsOk = canRunRepoScripts();
  const scriptReason = scriptsOk ? undefined : scriptsUnavailableReason();
  const hasDb = Boolean(process.env.DATABASE_URL);

  const dbReason = hasDb ? undefined : "未配置 DATABASE_URL，无法连库。";

  return [
    /* ------------------------------ 数据库 ------------------------------ */
    {
      id: "db.schema",
      label: "表结构浏览",
      description: "列出 public schema 下的表、列、索引、约束与外键。只读。",
      group: "database",
      availability: hasDb ? "available" : "unavailable",
      reason: dbReason,
      cost: "instant",
      mutates: false,
    },
    {
      id: "db.query",
      label: "只读查询",
      description: "执行单条 SELECT。语句经白名单校验，只允许读，带行数上限与超时。",
      group: "database",
      availability: hasDb ? "available" : "unavailable",
      reason: dbReason,
      cost: "seconds",
      mutates: false,
    },
    {
      id: "db.migrations",
      label: "迁移状态",
      description: "对比磁盘上的迁移文件与库内 drizzle.__drizzle_migrations 的实际记录。",
      group: "database",
      availability: hasDb ? "available" : "unavailable",
      reason: dbReason,
      cost: "seconds",
      mutates: false,
    },
    {
      id: "db.backup",
      label: "备份导出",
      description: "把全部业务表导出为 SQL 文本并下载。只读。",
      group: "database",
      availability: hasDb ? "available" : "unavailable",
      reason: dbReason,
      cost: "minutes",
      mutates: false,
    },
    {
      id: "db.restore",
      label: "备份恢复",
      description: "把备份文件写回数据库。",
      group: "database",
      availability: "disabled",
      reason:
        "运维台按你的选择采用「数据库只读」。恢复是写操作，只能在终端跑 npm run db:restore。",
      cost: "minutes",
      mutates: true,
    },

    /* ------------------------------ 脚本 ------------------------------ */
    {
      id: "script.preflight",
      label: "上线前预检",
      description: "跑 scripts/preflight.mjs，检查环境、迁移、构建产物、代码闸门、仓库卫生。",
      group: "script",
      availability: scriptsOk ? "available" : "unavailable",
      reason: scriptReason,
      cost: "minutes",
      mutates: false,
    },
    {
      id: "script.rollback",
      label: "回滚演练",
      description: "四腿演练：db/markdown × good/bad 数据库，验证回滚路径真的可用。",
      group: "script",
      availability: scriptsOk ? "available" : "unavailable",
      reason: scriptReason,
      cost: "minutes",
      mutates: false,
    },
    {
      id: "script.css",
      label: "CSS 完整性检查",
      description: "检查构建产物里 Tailwind 工具类是否齐全（P7 曾因 Webpack 路径漏跑 Tailwind）。",
      group: "script",
      availability: scriptsOk ? "available" : "unavailable",
      reason: scriptReason,
      cost: "seconds",
      mutates: false,
    },

    /* ------------------------------ 测试 ------------------------------ */
    {
      id: "test.unit",
      label: "单元与闸门测试",
      description: "跑 db:test + web:test + md:test 三套，逐段显示通过率。",
      group: "test",
      availability: scriptsOk ? "available" : "unavailable",
      reason: scriptReason,
      cost: "minutes",
      mutates: false,
    },
    {
      id: "test.browser",
      label: "浏览器验收",
      description: "Playwright 走真实浏览器验 49 条。需要先起本地服务与 CDP 端口。",
      group: "test",
      availability: scriptsOk ? "available" : "unavailable",
      reason: scriptReason,
      cost: "minutes",
      mutates: false,
    },

    /* ------------------------------ 运行态 ------------------------------ */
    {
      id: "runtime.health",
      label: "健康检查",
      description: "读 /api/health，显示库连通性、构建 ID 与时间戳。",
      group: "runtime",
      availability: "available",
      cost: "instant",
      mutates: false,
    },
    {
      id: "runtime.routes",
      label: "路由巡检",
      description: "按公开站点清单逐条请求，报告状态码、耗时与缓存头。",
      group: "runtime",
      availability: "available",
      cost: "seconds",
      mutates: false,
    },
    {
      id: "runtime.version",
      label: "版本一致性",
      description: "对比本机 git HEAD、构建 ID 与线上 /api/health 上报的版本。",
      group: "runtime",
      availability: "available",
      cost: "seconds",
      mutates: false,
    },

    /* ------------------------------ 导出 ------------------------------ */
    {
      id: "export.markdown",
      label: "Markdown 导出",
      description: "把库内容导出成 markdown 文件树（只写到本机 exports/，不改库）。",
      group: "export",
      availability: scriptsOk ? "available" : "unavailable",
      reason: scriptReason,
      cost: "seconds",
      mutates: false,
    },
    {
      id: "export.verify",
      label: "导出往返校验",
      description: "把导出的 markdown 重新走一遍 mapEntry，与库行逐字段比对。",
      group: "export",
      availability: scriptsOk ? "available" : "unavailable",
      reason: scriptReason,
      cost: "seconds",
      mutates: false,
    },

    /* ------------------------------ 环境 ------------------------------ */
    {
      id: "env.matrix",
      label: "环境变量矩阵",
      description: "列出关键变量的配置状态（值一律打码），并指出「配了但没人读」的无效项。",
      group: "env",
      availability: "available",
      cost: "instant",
      mutates: false,
    },
    {
      id: "env.vercel",
      label: "Vercel 项目状态",
      description: "读 Vercel API，显示项目、最近部署与域名绑定。需要 VERCEL_TOKEN。",
      group: "env",
      availability: process.env.VERCEL_TOKEN ? "available" : "unavailable",
      reason: process.env.VERCEL_TOKEN
        ? undefined
        : "未配置 VERCEL_TOKEN，无法查询 Vercel。可在本机 .env 里补上。",
      cost: "seconds",
      mutates: false,
    },
    {
      id: "env.neon",
      label: "Neon 数据库状态",
      description: "读 Neon API，显示项目、分支与计算节点状态。需要 NEON_API_KEY。",
      group: "env",
      availability: process.env.NEON_API_KEY ? "available" : "unavailable",
      reason: process.env.NEON_API_KEY
        ? undefined
        : "未配置 NEON_API_KEY，无法查询 Neon 控制面。数据库连通性请用「健康检查」。",
      cost: "seconds",
      mutates: false,
    },
  ];
}
