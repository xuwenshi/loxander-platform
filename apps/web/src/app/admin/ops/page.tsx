import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";

import { hasDatabaseUrl } from "@/lib/admin/db";
import { buildCapabilities, type Capability } from "@/lib/ops/capabilities";
import { getMigrationStatus } from "@/lib/ops/migrations";
import { probeSpawn, type SpawnProbe } from "@/lib/ops/runner";
import { getBuildInfo, readGitHead, type BuildInfo, type GitHead } from "@/lib/ops/runtime";

import { AvailabilityBadge, Chip, KeyValue, Notice, SectionSkeleton } from "./ops-ui";

export const metadata: Metadata = { title: "运维台" };

/**
 * 运维台总览（`/admin/ops`）。
 *
 * ── 这一页回答什么问题 ───────────────────────────────────────────────
 * 「现在这台机器 / 这个部署，哪些能力是通的，哪些是断的，断在哪一环。」
 * 它不重复 `/admin/settings` 的环境变量表（那里逐项列 12 个变量），
 * 而是给一张**能力 × 原因**的矩阵：18 项能力、每项一条判定依据。
 *
 * ── 为什么外壳静态、数据进 Suspense ──────────────────────────────────
 * 与 `app/admin/media/page.tsx:17-21` 同一理由：开了 `cacheComponents` 后，
 * 页面顶层 await 请求期数据（这里是读 `.next/BUILD_ID`、连库查迁移）会让
 * 整页退化成阻塞式预渲染，`next build` 报 blocking-prerender-runtime。
 *
 * ── 为什么这里要 connection() ────────────────────────────────────────
 * 这一页读的全是「当前进程看到的东西」：`.env` 内容、`.next/BUILD_ID`、
 * `.git/HEAD`、数据库里的迁移记录。静态烘焙出来的值会安静地骗人 ——
 * 构建机与运行实例未必是同一个环境（P8 期间就出现过「构建产物新、
 * 线上跑旧版」的事）。`connection()` 把这段子树钉到请求时刻。
 */
export default function OpsOverviewPage() {
  return (
    <Suspense fallback={<SectionSkeleton rows={6} />}>
      <OpsOverviewBody />
    </Suspense>
  );
}

async function OpsOverviewBody() {
  await connection();

  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const capabilities = buildCapabilities();
  const head = readGitHead();
  const build = getBuildInfo();
  const spawn = probeSpawn();

  // 迁移状态要连库。没配库时给 null，页面上显示「无法查询」而不是让它抛。
  const migrations =
    databaseUrl.length > 0 ? await getMigrationStatus(databaseUrl).catch(() => null) : null;

  const byGroup = groupCapabilities(capabilities);

  return (
    <div>
      <RuntimeStrip head={head} build={build} spawn={spawn} hasDatabaseUrl={hasDatabaseUrl()} />

      <section className="mt-8">
        <h2 className="text-sm font-medium text-foreground">能力矩阵</h2>
        <p className="mt-1 text-xs text-muted">
          共 {capabilities.length} 项。判定依据是环境变量的组合，不是独立配置 ——
          改变量即可，无需额外开关。点「不可用」的原因可以看到具体缺什么。
        </p>

        <div className="mt-4 space-y-6">
          {byGroup.map(([group, items]) => (
            <div key={group}>
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                {GROUP_LABEL[group]}
              </h3>
              <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border bg-elevated">
                {items.map((item) => (
                  <CapabilityRow key={item.id} item={item} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <MigrationStrip migrations={migrations} hasDatabaseUrl={databaseUrl.length > 0} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 运行态条                                                                    */
/* -------------------------------------------------------------------------- */

/** 顶部三条：当前提交、构建 ID、子进程能力。 */
function RuntimeStrip({
  head,
  build,
  spawn,
  hasDatabaseUrl: dbReady,
}: {
  head: GitHead | null;
  build: BuildInfo;
  spawn: SpawnProbe;
  hasDatabaseUrl: boolean;
}) {
  return (
    <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-xl border border-border bg-elevated p-3">
        <p className="text-xs text-muted">当前提交</p>
        <p className="mt-1 font-mono text-sm text-foreground">{head?.shortSha ?? "未知"}</p>
        <p className="mt-0.5 text-[11px] text-muted">
          {head ? `${head.branch ?? "detached"} · ${head.source}` : "读不到 .git"}
        </p>
      </div>

      <div className="rounded-xl border border-border bg-elevated p-3">
        <p className="text-xs text-muted">构建 ID</p>
        <p className="mt-1 break-all font-mono text-sm text-foreground">
          {build.buildId ?? "无产物"}
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          {build.nodeEnv} · Node {build.nodeVersion}
        </p>
      </div>

      <div className="rounded-xl border border-border bg-elevated p-3">
        <p className="text-xs text-muted">子进程能力</p>
        <p className="mt-1">
          {spawn.available ? (
            <Chip tone="ok" label="可 spawn" />
          ) : (
            <Chip tone="warn" label={spawn.code ?? "不可用"} />
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          {spawn.available
            ? `实测 ${spawn.elapsedMs}ms`
            : "跑脚本只能去终端（见检查页）"}
        </p>
      </div>

      <div className="rounded-xl border border-border bg-elevated p-3">
        <p className="text-xs text-muted">数据库</p>
        <p className="mt-1">
          {dbReady ? <Chip tone="ok" label="已配置" /> : <Chip tone="muted" label="未配置" />}
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          {dbReady ? "连接全程只读" : "缺 DATABASE_URL"}
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 能力矩阵                                                                    */
/* -------------------------------------------------------------------------- */

const GROUP_LABEL: Record<Capability["group"], string> = {
  database: "数据库",
  script: "运维脚本",
  test: "验收与测试",
  runtime: "运行态",
  export: "内容导出",
  env: "环境与凭据",
};

/** 按 group 分组，保持 `buildCapabilities()` 里的原始顺序。 */
function groupCapabilities(items: Capability[]): [Capability["group"], Capability[]][] {
  const order: Capability["group"][] = ["database", "script", "test", "runtime", "export", "env"];
  return order
    .map((group) => [group, items.filter((i) => i.group === group)] as [Capability["group"], Capability[]])
    .filter(([, list]) => list.length > 0);
}

function CapabilityRow({ item }: { item: Capability }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5 hover:bg-surface">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-foreground">{item.label}</span>
          <AvailabilityBadge availability={item.availability} />
          {item.mutates ? <Chip tone="warn" label="写操作" /> : null}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">{item.description}</p>
        {item.reason ? (
          <p className="mt-1 text-[11px] leading-relaxed text-warning">{item.reason}</p>
        ) : null}
      </div>
      <span className="shrink-0 font-mono text-[11px] text-muted">{COST_LABEL[item.cost]}</span>
    </li>
  );
}

const COST_LABEL: Record<Capability["cost"], string> = {
  instant: "即时",
  seconds: "数秒",
  minutes: "数分钟",
};

/* -------------------------------------------------------------------------- */
/* 迁移条                                                                      */
/* -------------------------------------------------------------------------- */

/** 迁移状态摘要。完整明细在 `/admin/ops/db`。 */
function MigrationStrip({
  migrations,
  hasDatabaseUrl: dbReady,
}: {
  migrations: Awaited<ReturnType<typeof getMigrationStatus>> | null;
  hasDatabaseUrl: boolean;
}) {
  if (!dbReady) {
    return <Notice tone="info">未配置 DATABASE_URL，迁移状态无法查询。</Notice>;
  }

  if (migrations === null) {
    return <Notice tone="error">查询迁移状态失败（连接或权限问题）。</Notice>;
  }

  const pendingCount = migrations.pending.length;

  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-foreground">迁移状态</h2>
      <div className="mt-3 rounded-xl border border-border bg-elevated p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip
            tone={migrations.error ? "error" : pendingCount === 0 ? "ok" : "warn"}
            label={migrations.error ? "查询失败" : pendingCount === 0 ? "已同步" : `${pendingCount} 份待应用`}
          />
          <span className="text-xs text-muted">
            库里 {migrations.appliedCount} 条记录 / 磁盘 {migrations.files.length} 份文件
          </span>
        </div>

        <div className="mt-2 space-y-1">
          <KeyValue label="跟踪表" value={migrations.trackingTableExists ? "存在" : "不存在"} />
          <KeyValue label="最近应用" value={migrations.lastAppliedAt ?? "无记录"} />
          <KeyValue label="目录" value={migrations.directory} />
        </div>

        {migrations.error ? <Notice tone="error">{migrations.error}</Notice> : null}

        {pendingCount > 0 ? (
          <Notice tone="warn">
            有 {pendingCount} 份迁移还没应用到库里：{migrations.pending.join("、")}。
            去终端跑 <code className="font-mono">npm run db:migrate</code>。
          </Notice>
        ) : null}

        {migrations.orphanHashes.length > 0 ? (
          <Notice tone="warn">
            库里有 {migrations.orphanHashes.length} 条迁移记录在磁盘上找不到对应文件 ——
            可能有人手改过迁移目录。去「数据库」页看逐份 sha256。
          </Notice>
        ) : null}

        <p className="mt-3 text-xs text-muted">
          逐份明细见{" "}
          <Link href="/admin/ops/db" className="text-accent underline-offset-2 hover:underline">
            数据库
          </Link>
          页。
        </p>
      </div>
    </section>
  );
}
