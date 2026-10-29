import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AdminStatusPill } from "@/components/admin/status-pill";
import { hasDatabaseUrl } from "@/lib/admin/db";
import {
  listEntries,
  parseDirection,
  parseKindFilter,
  parsePage,
  parsePageSize,
  parseSort,
  parseStatusFilter,
  type ListEntriesResult,
} from "@/lib/admin/entries";
import { ADMIN_STATUSES, KIND_LABELS, STATUS_LABELS } from "@/lib/admin/validation";
import { formatDate } from "@/lib/format";

import { BULK_ARCHIVE_FORM_ID, BulkArchiveBar } from "./bulk-archive-form";

export const metadata: Metadata = { title: "内容" };

/** Next 16 里 `searchParams` 是 Promise（`page.md`：`params`/`searchParams` 都要 await）。 */
export type ContentSearchParams = Promise<{
  kind?: string;
  status?: string;
  q?: string;
  sort?: string;
  direction?: string;
  page?: string;
  pageSize?: string;
}>;

const SORT_OPTIONS = [
  { value: "updated", label: "更新时间" },
  { value: "published", label: "发布时间" },
  { value: "title", label: "标题" },
] as const;

const KIND_OPTIONS = ["blog", "diary", "projects", "goals"] as const;

/**
 * 内容列表（`/admin/content`）。
 *
 * ── 为什么筛选条件全在 URL 上 ───────────────────────────────────────
 * 筛选状态放 URL（`?kind=blog&status=draft&page=2`）而不是组件 state，换来三件事：
 * ①刷新不丢筛选；②可以把「所有草稿」这个视图直接发给别人；③服务端渲染时
 * 一次就能查对数据，不需要先渲染全量再在客户端过滤（内容量大时后者不可接受）。
 *
 * ── 为什么页面本体是静态外壳 ────────────────────────────────────────
 * 开了 `cacheComponents`：`searchParams` 是运行时数据，在页面顶层 await 会让整页
 * 退化成阻塞式预渲染（构建报 blocking-prerender-runtime）。所以这里把
 * `searchParams` 这个 Promise **原样传下去**，在 `<Suspense>` 里 await。
 */
export default function ContentListPage({ searchParams }: { searchParams: ContentSearchParams }) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-xl font-medium tracking-tight text-foreground">内容</h1>
          <p className="mt-1 text-sm text-muted">
            按类型与状态筛选，支持关键词搜索。批量操作只允许归档 —— 永久删除会破坏版本历史。
          </p>
        </div>
        <Link
          href="/admin/new"
          className="rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-[var(--on-accent)] transition-opacity hover:opacity-90"
        >
          新建内容
        </Link>
      </header>

      <Suspense fallback={<ListSkeleton />}>
        <ContentListBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

/**
 * 真正查库的那一段。
 *
 * 参数全部经由 `entries.ts` 里的 `parse*` 函数收敛 —— 这些函数把非法值
 * 静默退回默认值而不是抛错。原因：URL 是用户可编辑的，`?page=abc` 不应该
 * 变成 500 页，应该就是第一页。
 */
async function ContentListBody({ searchParams }: { searchParams: ContentSearchParams }) {
  const params = await searchParams;

  const options = {
    kind: parseKindFilter(params.kind),
    status: parseStatusFilter(params.status),
    query: params.q?.trim() ?? "",
    sort: parseSort(params.sort),
    direction: parseDirection(params.direction),
    page: parsePage(params.page),
    pageSize: parsePageSize(params.pageSize),
  };

  if (!hasDatabaseUrl()) {
    return (
      <p className="mt-6 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        未配置 DATABASE_URL，无法读取内容列表。
      </p>
    );
  }

  const result = await listEntries(options);

  return (
    <>
      <FilterBar current={options} total={result.total} />

      {result.rows.length === 0 ? (
        <p className="mt-6 rounded-xl border border-border bg-elevated px-4 py-8 text-center text-sm text-muted">
          没有符合条件的内容。
          {options.query || options.status !== "all" || options.kind !== "all" ? (
            <Link href="/admin/content" className="ml-1 text-accent hover:underline">
              清除筛选
            </Link>
          ) : null}
        </p>
      ) : (
        <>
          <EntryTable result={result} />
          <BulkArchiveBar />
        </>
      )}

      <Pagination result={result} current={options} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* 筛选栏                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 筛选栏用**原生 GET 表单**，不是 Server Action。
 *
 * 理由：筛选是「读」操作，用 GET 让浏览器直接把字段拼进 query string，
 * 刷新/收藏/分享都能保留状态，也不需要为它写一个 action。
 */
function FilterBar({
  current,
  total,
}: {
  current: {
    kind: string;
    status: string;
    query: string;
    sort: string;
    direction: string;
  };
  total: number;
}) {
  return (
    <form method="get" className="mt-6 rounded-xl border border-border bg-elevated p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">类型</span>
          <select
            name="kind"
            defaultValue={current.kind}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground"
          >
            <option value="all">全部</option>
            {KIND_OPTIONS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">状态</span>
          <select
            name="status"
            defaultValue={current.status}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground"
          >
            <option value="all">全部</option>
            {ADMIN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">关键词</span>
          <input
            type="search"
            name="q"
            defaultValue={current.query}
            placeholder="标题或 slug"
            className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground placeholder:text-muted-deep"
          />
        </label>

        <div className="block">
          {/* 这里的「排序」用 span 而不是 label（列对齐需要 block 包裹），
              所以下拉必须自带 aria-label，否则读屏只念「组合框」。
              与相邻的「排序方向」（aria-label="排序方向"）对齐。 */}
          <span className="mb-1 block text-xs font-medium text-muted">排序</span>
          <div className="flex gap-2">
            <select
              name="sort"
              defaultValue={current.sort}
              aria-label="排序"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              name="direction"
              defaultValue={current.direction}
              aria-label="排序方向"
              className="w-20 shrink-0 rounded-lg border border-border bg-background px-2 py-2 text-sm text-foreground"
            >
              <option value="desc">降序</option>
              <option value="asc">升序</option>
            </select>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          共 <span className="font-medium tabular-nums text-foreground">{total}</span> 条
        </p>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/content"
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
          >
            重置
          </Link>
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] transition-opacity hover:opacity-90"
          >
            应用筛选
          </button>
        </div>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* 表格                                                                        */
/* -------------------------------------------------------------------------- */

function EntryTable({ result }: { result: ListEntriesResult }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-elevated">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            {/* 批量选择：勾选框通过 `form` 属性关联到表格下方的 BulkArchiveBar。 */}
            <th scope="col" className="w-10 px-3 py-2.5">
              <span className="sr-only">选择</span>
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              标题
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              类型
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              状态
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              版本
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">
              更新时间
            </th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <tr key={row.id} className="border-b border-border last:border-0 hover:bg-surface">
              <td className="px-3 py-2.5 align-middle">
                {/* `form` 属性把勾选框关联到表格下方那个 form（按 id 关联，
                    与 DOM 顺序无关）。这样整张表是 Server 渲染的原生 table，
                    只有提交栏是客户端组件。 */}
                <input
                  type="checkbox"
                  name="entryId"
                  value={row.id}
                  form={BULK_ARCHIVE_FORM_ID}
                  aria-label={`选择「${row.title || row.slug}」`}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
              </td>
              <td className="px-3 py-2.5">
                <Link
                  href={`/admin/content/${row.kind}/${encodeURIComponent(row.slug)}`}
                  className="font-medium text-foreground hover:text-accent"
                >
                  {row.title || "(无标题)"}
                </Link>
                <p className="mt-0.5 font-mono text-[11px] text-muted">{row.slug}</p>
              </td>
              <td className="px-3 py-2.5 text-muted">{KIND_LABELS[row.kind]}</td>
              <td className="px-3 py-2.5">
                <AdminStatusPill status={row.publishStatus} />
              </td>
              <td className="px-3 py-2.5 tabular-nums text-muted">v{row.version}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                {formatDate(row.updatedAt.toISOString())}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 分页                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 分页。
 *
 * 只渲染「上一页 / 下一页 + 当前页/总页数」，不做数字页码列表 —— 后台内容
 * 量通常在几十到几百条，全部列出页码反而占地方。链接保留当前所有筛选条件。
 */
function Pagination({
  result,
  current,
}: {
  result: ListEntriesResult;
  current: {
    kind: string;
    status: string;
    query: string;
    sort: string;
    direction: string;
    pageSize: number;
  };
}) {
  if (result.pageCount <= 1) return null;

  const linkTo = (page: number) => {
    const search = new URLSearchParams();
    if (current.kind !== "all") search.set("kind", current.kind);
    if (current.status !== "all") search.set("status", current.status);
    if (current.query) search.set("q", current.query);
    if (current.sort !== "updated") search.set("sort", current.sort);
    if (current.direction !== "desc") search.set("direction", current.direction);
    search.set("pageSize", String(current.pageSize));
    if (page > 1) search.set("page", String(page));
    return `/admin/content?${search.toString()}`;
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

/** Suspense 骨架。刻意与真实表格同高，避免加载完成时页面跳动。 */
function ListSkeleton() {
  return (
    <div className="mt-6 space-y-3" aria-busy="true">
      <div className="h-28 animate-pulse rounded-xl border border-border bg-elevated" />
      <div className="h-64 animate-pulse rounded-xl border border-border bg-elevated" />
    </div>
  );
}
