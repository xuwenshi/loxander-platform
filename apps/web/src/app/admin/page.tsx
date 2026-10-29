import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";

import {
  countEntriesByKindAndStatus,
  listEntries,
  type EntryStatRow,
} from "@/lib/admin/entries";
import { hasDatabaseUrl } from "@/lib/admin/db";
import { KIND_LABELS, type AdminStatus } from "@/lib/admin/validation";
import { formatDate } from "@/lib/format";
import { AdminStatusPill } from "@/components/admin/status-pill";

export const metadata: Metadata = { title: "总览" };

const KIND_ORDER = ["blog", "diary", "projects", "goals"] as const;

/**
 * 后台总览（`/admin`）。
 *
 * ── 守卫不用在这里写 ───────────────────────────────────────────────
 * `app/admin/layout.tsx` 已经拦过一道（`getAdminSession()` 为空就跳 `/login`），
 * 所以这个页面可以直接假定「有人在看」。少写一次的好处是：以后加页面不会忘。
 *
 * ── 为什么先判断 hasDatabaseUrl ────────────────────────────────────
 * `listEntries()` 在缺 `DATABASE_URL` 时会抛错（`lib/admin/db.ts` 的显式设计，
 * 不静默返回空数组）。总览页是登录后的第一屏，直接崩在 500 页上体验很差，
 * 所以这里预先分支，把「没配库」变成一句人话 + 明确的下一步。
 */
export default function AdminDashboardPage() {
  // 静态外壳 + Suspense：与 `/admin/content`、`/admin/new` 同一形态。
  // 动态读取（`connection()` + 两次查库）必须在 Suspense 边界内，否则 Next 会报
  // blocking-prerender-dynamic（实测：Route "/admin" 的 stderr 告警）。
  // 文档：node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardBody />
    </Suspense>
  );
}

async function DashboardBody() {
  // 开了 `cacheComponents`：这一页读的是数据库（uncached data），必须显式声明
  // 「等请求到达再渲染」。`connection()` 放在 Suspense 内是对的 —— 它把这段子树
  // 钉到请求时刻，同时静态外壳仍然可以被预渲染。
  await connection();

  if (!hasDatabaseUrl()) {
    return <MissingDatabase />;
  }

  const [stats, recent] = await Promise.all([
    countEntriesByKindAndStatus(),
    listEntries({ sort: "updated", direction: "desc", pageSize: 8 }),
  ]);

  const matrix = buildMatrix(stats);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-xl font-medium tracking-tight text-foreground">总览</h1>
          <p className="mt-1 text-sm text-muted">
            内容状态一览与最近改动。所有写操作都会留下版本快照与审计记录。
          </p>
        </div>
        <Link
          href="/admin/new"
          className="rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-[var(--on-accent)] transition-opacity hover:opacity-90"
        >
          新建内容
        </Link>
      </header>

      <section className="mt-6" aria-label="内容统计">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {KIND_ORDER.map((kind) => {
            const row = matrix.get(kind) ?? emptyRow(kind);
            return (
              <Link
                key={kind}
                href={`/admin/content?kind=${kind}`}
                className="rounded-xl border border-border bg-elevated p-4 transition-colors hover:border-accent/50"
              >
                <p className="text-sm font-medium text-foreground">{KIND_LABELS[kind]}</p>
                <p className="mt-2 font-mono text-2xl font-medium tabular-nums text-foreground">
                  {row.total}
                </p>
                <dl className="mt-3 space-y-1 text-xs">
                  <StatLine label="已发布" value={row.published} tone="success" />
                  <StatLine label="草稿" value={row.draft} />
                  <StatLine label="定时" value={row.scheduled} />
                  <StatLine label="已归档" value={row.archived} />
                </dl>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mt-8" aria-label="最近改动">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-sm font-medium text-foreground">最近改动</h2>
          <Link href="/admin/content?sort=updated" className="text-xs text-accent hover:underline">
            查看全部
          </Link>
        </div>

        {recent.rows.length === 0 ? (
          <p className="mt-3 rounded-xl border border-border bg-elevated px-4 py-6 text-sm text-muted">
            库里还没有内容。先用导入器把 Markdown 导进来，或者点「新建内容」。
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-elevated">
            {recent.rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/admin/content/${row.kind}/${encodeURIComponent(row.slug)}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-surface"
                >
                  <AdminStatusPill status={row.publishStatus} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {row.title || "(无标题)"}
                  </span>
                  <span className="text-xs text-muted">{KIND_LABELS[row.kind]}</span>
                  <span className="w-28 text-right text-xs tabular-nums text-muted">
                    {formatDate(row.updatedAt.toISOString())}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface KindTotals {
  total: number;
  published: number;
  draft: number;
  scheduled: number;
  archived: number;
}

function emptyRow(kind: (typeof KIND_ORDER)[number]): KindTotals {
  void kind;
  return { total: 0, published: 0, draft: 0, scheduled: 0, archived: 0 };
}

/**
 * 把「类型 × 状态」的长表摊成每类一行的汇总。
 *
 * 数据库返回的是 GROUP BY 的稀疏结果（某类没有草稿就不会有那行），
 * 所以这里必须用 `?? 0` 补齐，否则页面会出现 `undefined`。
 */
function buildMatrix(stats: EntryStatRow[]): Map<string, KindTotals> {
  const matrix = new Map<string, KindTotals>();
  for (const row of stats) {
    const current = matrix.get(row.kind) ?? emptyRow(row.kind);
    current.total += row.value;
    current[row.status as AdminStatus] += row.value;
    matrix.set(row.kind, current);
  }
  return matrix;
}

function StatLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success";
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted">{label}</dt>
      <dd
        className={
          value > 0 && tone === "success"
            ? "tabular-nums font-medium text-success"
            : "tabular-nums text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

/** 缺库时的落地页：说清楚「为什么」和「怎么办」。 */function MissingDatabase() {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="font-serif text-xl font-medium tracking-tight text-foreground">后台尚未连接数据库</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        后台的所有操作都直接读写 Postgres，没有 <code className="font-mono">DATABASE_URL</code>{" "}
        就没有任何内容可显示。这不是权限问题，是配置缺失。
      </p>
      <ol className="mt-4 space-y-2 text-sm leading-relaxed text-muted">
        <li>
          1. 在 <code className="font-mono">.env.local</code> 里设置{" "}
          <code className="font-mono">DATABASE_URL</code>（Neon 控制台 → Dashboard →
          Connection string，必须带 <code className="font-mono">sslmode=require</code>）。
        </li>
        <li>
          2. 跑一次 <code className="font-mono">npm run db:migrate</code> 把表建出来。
        </li>
        <li>
          3. 用 <code className="font-mono">npm run db:import</code> 导入 Markdown 内容。
        </li>
        <li>4. 重启 dev server。</li>
      </ol>
      <p className="mt-4 text-xs text-muted">
        前台不受影响：只要 <code className="font-mono">CONTENT_SOURCE=markdown</code>，
        站点仍然从文件系统读取。
      </p>
    </div>
  );
}

/** 总览的加载骨架：只画块，不显示任何真实数字。 */
function DashboardSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl" aria-busy="true">
      <div className="h-8 w-40 animate-pulse rounded-lg bg-surface" />
      <div className="mt-2 h-4 w-72 animate-pulse rounded bg-surface" />
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((key) => (
          <div
            key={key}
            className="h-40 animate-pulse rounded-xl border border-border bg-elevated"
          />
        ))}
      </div>
      <div className="mt-8 h-56 animate-pulse rounded-xl border border-border bg-elevated" />
    </div>
  );
}
