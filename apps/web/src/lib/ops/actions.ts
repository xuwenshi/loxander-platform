"use server";

import { auditLogs } from "../../../../../db/schema";
import { requireAdmin } from "../auth";
import { getAdminDb } from "../admin/db";

import { createBackup, listBackups, verifyBackup, type BackupFileInfo, type BackupResult, type BackupVerifyResult } from "./backup";
import {
  buildCapabilities,
  type Capability,
} from "./capabilities";
import { runReadOnlyQuery, type ReadOnlyQueryError, type ReadOnlyQueryResult } from "./db-readonly";
import { getTableStructure, listTables, type TableStructure, type TableSummary } from "./db-schema";
import { getEnvMatrix, getNeonStatus, getVercelStatus, type EnvMatrix, type NeonStatus, type VercelStatus } from "./env";
import { getMigrationStatus, type MigrationStatus } from "./migrations";
import {
  checkVersionConsistency,
  probeDatabase,
  probeRoutes,
  type HealthProbe,
  type RouteProbe,
  type VersionConsistency,
} from "./runtime";
import { probeSpawn, runAllLocalChecks, runCheck, type CheckId, type CheckResult, type SpawnProbe } from "./runner";

/**
 * 运维台的 Server Actions。
 *
 * ── 为什么每一个 action 都要自己 `requireAdmin()` ────────────────────
 * Next 16 的 proxy 文档（`proxy.md:249-251`）明确写：Server Function 不是独立
 * 路由，它是「POST 到它所处的那条路由」，proxy matcher 排除的路径上 proxy
 * 根本拦不到。现有 `proxy.ts` 的 matcher 排除了 `api/`，运维台又全在
 * `/admin/**` 里 —— 但那只说明「读页面」被 layout 拦住了，**不代表
 * action 的 POST 也被拦住**。所以每个 action 第一行就是 `requireAdmin()`。
 *
 * ── 为什么这些 action 大部分不写审计 ─────────────────────────────────
 * 方案 §8.4 的七道关针对的是**写操作**。运维台的绝大多数动作是只读的
 * （查表结构、跑检查、看环境），把每一次读都写进 `audit_logs` 会让审计表
 * 被读操作淹没，反而看不出真正的变更。所以：
 * - 只读动作：不写审计（但都会过 `requireAdmin()`）。
 * - **产生副作用的动作**：写审计。目前有两个 —— `createBackupAction`
 *   （在磁盘上生成文件）与查询被拒绝时（`ops.query_rejected`，
 *   这是安全事件，必须留痕）。
 *
 * ── 为什么返回值都是普通对象而不是抛错 ───────────────────────────────
 * 与 `lib/admin/actions.ts` 的 `ActionResult` 同一理由：抛错会让 Next 渲染
 * 错误页，运维台上一整屏的检查结果就全丢了。结构化返回让页面能就地显示
 * 「这一项失败了，原因是什么」。
 */

/* -------------------------------------------------------------------------- */
/* 统一返回                                                                    */
/* -------------------------------------------------------------------------- */

/** 运维台所有 action 的统一返回。 */
export interface OpsResult<T> {
  ok: boolean;
  data?: T;
  /** 面向用户的一句话错误。 */
  error?: string;
  /** 执行耗时（毫秒）。 */
  elapsedMs: number;
}

/** 包一层计时与错误捕获，避免每个 action 重复写 try/catch。 */
async function wrap<T>(run: () => Promise<T>): Promise<OpsResult<T>> {
  const startedAt = Date.now();
  try {
    const data = await run();
    return { ok: true, data, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/** 当前数据库连接串（没有就是 null）。 */
function databaseUrl(): string | null {
  const url = (process.env.DATABASE_URL ?? "").trim();
  return url.length > 0 ? url : null;
}

/** 写一条审计。失败不阻断主流程 —— 审计写不进去不该让运维动作本身失败。 */
async function recordAudit(entry: {
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const admin = await requireAdmin();
    const db = await getAdminDb();
    await db.insert(auditLogs).values({
      actor_id: admin.id,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      detail: entry.detail ?? {},
    });
  } catch (error) {
    console.error("[ops] 写审计失败：", error);
  }
}

/* -------------------------------------------------------------------------- */
/* 能力清单                                                                    */
/* -------------------------------------------------------------------------- */

/** 取能力矩阵（18 项，含可用性判定与不可用原因）。 */
export async function loadCapabilitiesAction(): Promise<OpsResult<Capability[]>> {
  return wrap(async () => {
    await requireAdmin();
    return buildCapabilities();
  });
}

/* -------------------------------------------------------------------------- */
/* 数据库：结构                                                                */
/* -------------------------------------------------------------------------- */

/** 列出 public schema 下的全部表。 */
export async function loadTablesAction(): Promise<OpsResult<TableSummary[]>> {
  return wrap(async () => {
    await requireAdmin();
    const url = databaseUrl();
    if (url === null) throw new Error("未配置 DATABASE_URL，无法连库。");
    return listTables(url);
  });
}

/** 取单张表的完整结构。表不存在时返回 null（页面据此 404）。 */
export async function loadTableStructureAction(
  table: string,
): Promise<OpsResult<TableStructure | null>> {
  return wrap(async () => {
    await requireAdmin();
    const url = databaseUrl();
    if (url === null) throw new Error("未配置 DATABASE_URL，无法连库。");
    return getTableStructure(url, table);
  });
}

/* -------------------------------------------------------------------------- */
/* 数据库：只读查询                                                            */
/* -------------------------------------------------------------------------- */

/** 只读查询的返回形态。 */
export type QueryActionData =
  | { kind: "ok"; result: ReadOnlyQueryResult }
  | { kind: "rejected"; error: ReadOnlyQueryError }
  | { kind: "unavailable"; error: ReadOnlyQueryError };

/**
 * 执行一条只读 SQL。
 *
 * 四道闸全在 `runReadOnlyQuery()` 里（连接级只读 GUC / 单条语句 / 关键词
 * 黑名单 / 超时）。这里额外做两件事：①没配库时给一句人话；
 * ②**被拒绝的语句写审计** —— 有人试图在只读面板上跑 DELETE，这件事本身
 * 比查询结果重要得多。
 */
export async function runQueryAction(sql: string): Promise<OpsResult<QueryActionData>> {
  return wrap(async () => {
    await requireAdmin();

    const url = databaseUrl();
    if (url === null) {
      return {
        kind: "unavailable" as const,
        error: { message: "未配置 DATABASE_URL，无法执行查询。" },
      };
    }

    const outcome = await runReadOnlyQuery(url, sql);
    if (!outcome.ok) {
      await recordAudit({
        action: "ops.query_rejected",
        entityType: "ops",
        detail: { sql: sql.slice(0, 500), message: outcome.error.message },
      });
      return { kind: "rejected" as const, error: outcome.error };
    }

    return { kind: "ok" as const, result: outcome.result };
  });
}

/* -------------------------------------------------------------------------- */
/* 数据库：迁移                                                                */
/* -------------------------------------------------------------------------- */

/** 迁移状态（磁盘 + 库内）。 */
export async function loadMigrationStatusAction(): Promise<OpsResult<MigrationStatus>> {
  return wrap(async () => {
    await requireAdmin();
    return getMigrationStatus(databaseUrl());
  });
}

/* -------------------------------------------------------------------------- */
/* 数据库：备份                                                                */
/* -------------------------------------------------------------------------- */

/** 备份文件清单。 */
export async function loadBackupsAction(): Promise<OpsResult<BackupFileInfo[]>> {
  return wrap(async () => {
    await requireAdmin();
    return listBackups();
  });
}

/**
 * 创建一份备份。
 *
 * **这是运维台唯一会写磁盘的动作**，所以它写审计。注意它仍然不写数据库 ——
 * `createBackup()` 用的是只读连接，只做「读出来存成 JSON」。
 */
export async function createBackupAction(): Promise<OpsResult<BackupResult>> {
  return wrap(async () => {
    await requireAdmin();
    const url = databaseUrl();
    if (url === null) throw new Error("未配置 DATABASE_URL，无法备份。");

    const result = await createBackup(url);

    await recordAudit({
      action: "ops.backup_created",
      entityType: "ops",
      entityId: result.file ?? null,
      detail: { ok: result.ok, bytes: result.bytes ?? 0, totalRows: result.totalRows ?? 0 },
    });

    return result;
  });
}

/** 校验一份备份（只比行数，不比内容）。 */
export async function verifyBackupAction(file: string): Promise<OpsResult<BackupVerifyResult>> {
  return wrap(async () => {
    await requireAdmin();
    const url = databaseUrl();
    if (url === null) throw new Error("未配置 DATABASE_URL，无法校验备份。");
    return verifyBackup(url, file);
  });
}

/* -------------------------------------------------------------------------- */
/* 运行态                                                                      */
/* -------------------------------------------------------------------------- */

/** 数据库连通性 + 只读 GUC 是否真的生效。 */
export async function probeDatabaseAction(): Promise<OpsResult<HealthProbe>> {
  return wrap(async () => {
    await requireAdmin();
    const url = databaseUrl();
    if (url === null) throw new Error("未配置 DATABASE_URL，无法探测数据库。");
    return probeDatabase(url);
  });
}

/** 路由巡检。`baseUrl` 由页面传（从请求头或 SITE_URL 拼）。 */
export async function probeRoutesAction(baseUrl: string): Promise<OpsResult<RouteProbe[]>> {
  return wrap(async () => {
    await requireAdmin();
    return probeRoutes(baseUrl);
  });
}

/** 本机 HEAD 与线上上报版本是否一致。 */
export async function checkVersionAction(): Promise<OpsResult<VersionConsistency>> {
  return wrap(async () => {
    await requireAdmin();
    // `checkVersionConsistency` 的 `remoteUrl` 是必填的（它要拼 `/api/health`）。
    // 优先用 `NEXT_PUBLIC_SITE_URL`（代码真正读的那个），回退到生产域名 ——
    // 与 `lib/site.ts:68` 的默认值同源，避免这里和站点配置漂移。
    const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
    return checkVersionConsistency({
      remoteUrl: siteUrl.length > 0 ? siteUrl : "https://loxander.is-a.dev",
    });
  });
}

/* -------------------------------------------------------------------------- */
/* 检查                                                                        */
/* -------------------------------------------------------------------------- */

/** 跑一项进程内检查。 */
export async function runCheckAction(
  id: CheckId,
  baseUrl?: string,
): Promise<OpsResult<CheckResult>> {
  return wrap(async () => {
    await requireAdmin();
    return runCheck(id, { baseUrl });
  });
}

/** 跑全部本地检查（不需要 baseUrl 的那五项）。 */
export async function runAllChecksAction(): Promise<OpsResult<CheckResult[]>> {
  return wrap(async () => {
    await requireAdmin();
    return runAllLocalChecks();
  });
}

/** 探测本进程能不能起子进程（决定「哪些脚本只能去终端跑」）。 */
export async function probeSpawnAction(): Promise<OpsResult<SpawnProbe>> {
  return wrap(async () => {
    await requireAdmin();
    return probeSpawn();
  });
}

/* -------------------------------------------------------------------------- */
/* 环境与外部平台                                                              */
/* -------------------------------------------------------------------------- */

/** 环境矩阵（配置项状态 + 能力开关 + 平台可用性）。 */
export async function loadEnvMatrixAction(): Promise<OpsResult<EnvMatrix>> {
  return wrap(async () => {
    await requireAdmin();
    return getEnvMatrix();
  });
}

/** Vercel 项目与最近部署。 */
export async function loadVercelStatusAction(): Promise<OpsResult<VercelStatus>> {
  return wrap(async () => {
    await requireAdmin();
    return getVercelStatus();
  });
}

/** Neon 项目状态。 */
export async function loadNeonStatusAction(): Promise<OpsResult<NeonStatus>> {
  return wrap(async () => {
    await requireAdmin();
    return getNeonStatus();
  });
}
