import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { hasDatabaseUrl } from "@/lib/admin/db";
import { listAuditLogs, parsePage, type AuditRow } from "@/lib/admin/entries";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "审计日志" };

/**
 * 审计日志（`/admin/audit`）。
 *
 * ── 为什么要有这一页 ─────────────────────────────────────────────────
 * 方案 §9.8 要求「所有写操作留审计」。但写进库里的东西如果没人能看，
 * 出问题时就等于没记 —— 这一页是审计数据的唯一出口。
 *
 * ── 为什么筛选只做 action 前缀 ───────────────────────────────────────
 * 审计表的增长比内容快一个量级（每次保存都一条）。真正有用的切片是
 * 「只看登录事件」（`auth.`）或「只看内容变更」（`entry.`），所以按
 * `action` 前缀过滤；actor / 时间范围这类筛选等数据量上来再加，
 * 现在加只会让查询计划变复杂。
 *
 * ── 为什么外壳是静态的 ───────────────────────────────────────────────
 * `cacheComponents` 下 `searchParams` 是运行时数据，顶层 await 会让整页
 * 变成阻塞式预渲染。所以筛选栏（纯链接）放外壳，查库的部分进 `<Suspense>`。
 */
export default function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; action?: string }>;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">审计日志</h1>
        <p className="mt-1 text-sm text-muted">
          登录、创建、保存、发布、归档、恢复都会留下记录。日志只增不改 ——
          后台没有任何删除审计的入口。
        </p>
      </header>

      <Suspense fallback={<ListSkeleton />}>
        <AuditBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const ACTION_FILTERS = [
  { value: "", label: "全部" },
  { value: "auth.", label: "登录事件" },
  { value: "entry.", label: "内容变更" },
] as const;

async function AuditBody({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; action?: string }>;
}) {
  const params = await searchParams;
  const page = parsePage(params.page);
  const actionPrefix = typeof params.action === "string" ? params.action : "";

  if (!hasDatabaseUrl()) {
    return (
      <p className="mt-6 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        未配置 DATABASE_URL，无法读取审计日志。
      </p>
    );
  }

  const result = await listAuditLogs({
    page,
    actionPrefix: actionPrefix || undefined,
  });

  return (
    <>
      <nav aria-label="日志筛选" className="mt-5 flex flex-wrap gap-2">
        {ACTION_FILTERS.map((filter) => {
          const active = filter.value === actionPrefix;
          const href = filter.value ? `/admin/audit?action=${filter.value}` : "/admin/audit";
          return (
            <Link
              key={filter.value || "all"}
              href={href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-[var(--on-accent)]"
                  : "rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
              }
            >
              {filter.label}
            </Link>
          );
        })}
        <span className="ml-auto self-center text-xs text-muted">
          共 <span className="font-medium tabular-nums text-foreground">{result.total}</span> 条
        </span>
      </nav>

      {result.rows.length === 0 ? (
        <p className="mt-6 rounded-xl border border-border bg-elevated px-4 py-8 text-center text-sm text-muted">
          还没有任何审计记录。
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-elevated">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th scope="col" className="px-3 py-2.5 font-medium">
                  时间
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  操作人
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  动作
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  对象
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  详情
                </th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0 hover:bg-surface">
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums text-muted">
                    {formatDate(row.createdAt.toISOString())}
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    {row.actorLogin ? (
                      <span className="font-mono text-foreground">{row.actorLogin}</span>
                    ) : row.actorId ? (
                      <span className="font-mono text-muted">{row.actorId.slice(0, 8)}</span>
                    ) : (
                      <span className="text-muted-deep">系统</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                      {row.action}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted">
                    {row.entityType}
                    {row.entityId ? (
                      <span className="ml-1 font-mono text-muted-deep">
                        {row.entityId.slice(0, 8)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    <DetailCell detail={row.detail} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination result={result} actionPrefix={actionPrefix} />
    </>
  );
}

/**
 * 详情列：把 jsonb 摊成 `k=v` 一行。
 *
 * 不做 JSON 折叠面板 —— 审计详情通常只有两三个键，展开一次反而更慢。
 * 值太长（比如整段快照）就截断，避免把表格撑爆。
 */
function DetailCell({ detail }: { detail: Record<string, unknown> }) {
  const entries = Object.entries(detail);
  if (entries.length === 0) return <span className="text-xs text-muted-deep">—</span>;

  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1 text-[11px]">
      {entries.map(([key, value]) => (
        <span key={key} className="rounded-md border border-border px-1.5 py-0.5">
          <span className="text-muted-deep">{key}</span>
          <span className="mx-1 text-muted-deep">=</span>
          <span className="font-mono text-foreground">{shortValue(value)}</span>
        </span>
      ))}
    </span>
  );
}

function shortValue(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  if (text === undefined) return "null";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function Pagination({
  result,
  actionPrefix,
}: {
  result: { page: number; pageCount: number };
  actionPrefix: string;
}) {
  if (result.pageCount <= 1) return null;

  const linkTo = (page: number) => {
    const search = new URLSearchParams();
    if (actionPrefix) search.set("action", actionPrefix);
    if (page > 1) search.set("page", String(page));
    const query = search.toString();
    return query ? `/admin/audit?${query}` : "/admin/audit";
  };

  return (
    <nav aria-label="分页" className="mt-4 flex items-center justify-between text-sm">
      {result.page > 1 ? (
        <Link href={linkTo(result.page - 1)} className="text-accent hover:underline">
          ← 上一页
        </Link>
      ) : (
        <span className="text-muted-deep">← 上一页</span>
      )}

      <span className="text-xs tabular-nums text-muted">
        第 {result.page} / {result.pageCount} 页
      </span>

      {result.page < result.pageCount ? (
        <Link href={linkTo(result.page + 1)} className="text-accent hover:underline">
          下一页 →
        </Link>
      ) : (
        <span className="text-muted-deep">下一页 →</span>
      )}
    </nav>
  );
}

function ListSkeleton() {
  return (
    <div className="mt-6 space-y-3" aria-busy="true">
      <div className="h-9 w-64 animate-pulse rounded-lg bg-surface" />
      <div className="h-64 animate-pulse rounded-xl border border-border bg-elevated" />
    </div>
  );
}

/** 保留导出：`AuditRow` 是这一页的数据形状，供以后拆出客户端组件时复用。 */
export type { AuditRow };
