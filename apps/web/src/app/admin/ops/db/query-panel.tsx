"use client";

import { useState, useTransition } from "react";

import { runQueryAction, type QueryActionData } from "@/lib/ops/actions";
import type { ReadOnlyQueryResult } from "@/lib/ops/db-readonly";

import { Chip, Notice } from "../ops-ui";

/**
 * 只读查询面板（客户端）。
 *
 * ── 为什么查询走 Server Action 而不是 Route Handler ───────────────────
 * 两条理由：①`requireAdmin()` 是现成的、与后台其它写操作同一套判据，
 * Route Handler 要重写一遍会话校验；②查询结果不需要被外部程序消费，
 * 不需要稳定的 HTTP 契约。
 *
 * ── 为什么这里「只读」不是靠前端 ─────────────────────────────────────
 * 前端什么也保证不了 —— 用户可以绕过 UI 直接 POST Server Action。
 * 真正的四道闸全在 `lib/ops/db-readonly.ts` 的 `runReadOnlyQuery()` 里：
 * 连接级 `default_transaction_read_only=on`（Postgres 自己拒绝写）、
 * 单条语句限制、36 个关键词黑名单、超时。这里的输入框只是便利。
 *
 * ── 为什么默认值是这条 SQL ───────────────────────────────────────────
 * 默认给一条「立刻有结果、且能证明只读生效」的查询：`current_setting`
 * 会把连接级 GUC 的真实值打出来。运维者第一次点「执行」就能看到
 * `default_transaction_read_only = on` —— 这是自证，不是承诺。
 */
const DEFAULT_SQL = "select current_setting('default_transaction_read_only') as read_only, now() as server_time";

export function QueryPanel({ enabled }: { enabled: boolean }) {
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [outcome, setOutcome] = useState<QueryActionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const response = await runQueryAction(sql);
      setElapsed(response.elapsedMs);
      if (!response.ok) {
        setOutcome(null);
        setError(response.error ?? "查询失败，但没有返回原因。");
        return;
      }
      setOutcome(response.data ?? null);
    });
  }

  if (!enabled) {
    return <Notice tone="info">未配置 DATABASE_URL，只读查询不可用。</Notice>;
  }

  return (
    <div className="mt-3">
      <label htmlFor="ops-sql" className="text-xs font-medium text-foreground">
        SQL（只允许单条 SELECT / WITH / TABLE / VALUES）
      </label>
      <textarea
        id="ops-sql"
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        rows={6}
        spellCheck={false}
        // font-mono：SQL 的对齐与关键词靠等宽字体才看得清。
        className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-border-focus focus:ring-2 focus:ring-ring"
      />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          // min-h-11：主操作按钮命中区域 44px（WCAG 2.5.5）。
          className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "执行中…" : "执行"}
        </button>

        <button
          type="button"
          onClick={() => {
            setSql(DEFAULT_SQL);
            setOutcome(null);
            setError(null);
            setElapsed(null);
          }}
          className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-xs text-muted transition-colors hover:text-foreground"
        >
          重置
        </button>

        <span className="text-[11px] text-muted">
          上限 500 行 · 语句超时 8s · 总超时 15s
          {elapsed !== null ? ` · 本次 ${elapsed}ms` : ""}
        </span>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {outcome?.kind === "rejected" ? (
        <Notice tone="error">
          语句被拒绝：{outcome.error.message}
          {outcome.error.code ? `（错误码 ${outcome.error.code}）` : ""}
          <br />
          这次尝试已写入审计日志（<code className="font-mono">ops.query_rejected</code>）。
        </Notice>
      ) : null}

      {outcome?.kind === "ok" ? <ResultTable result={outcome.result} /> : null}
    </div>
  );
}

/**
 * 查询结果表。
 *
 * ── 为什么用 `overflow-x-auto` 而不是换行 ─────────────────────────────
 * 结果集的列数是运行时才知道的（`select *` 可以有 18 列）。让单元格换行
 * 会把一张表压成一条条竖着的文字，彻底失去「横向比对一行」的能力。
 * 横向滚动是唯一保住表格语义的排法 —— 与 `/admin/settings` 的配置表同口径。
 *
 * ── 为什么值要 `JSON.stringify` 兜底 ──────────────────────────────────
 * postgres-js 可能返回 `Date` / 数组 / JSONB 对象。直接 `{value}` 渲染
 * 对象会抛 `Objects are not valid as a React child`。统一序列化最稳。
 */
function ResultTable({ result }: { result: ReadOnlyQueryResult }) {
  if (result.rows.length === 0) {
    return <Notice tone="info">查询成功，返回 0 行。</Notice>;
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <Chip tone="ok" label={`${result.rows.length} 行`} />
        <span>{result.columns.length} 列</span>
        <span>· {result.elapsedMs}ms</span>
        {result.truncated ? <Chip tone="warn" label="已截断到 500 行" /> : null}
      </div>

      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-surface text-left text-muted">
              {result.columns.map((column) => (
                <th key={column} scope="col" className="whitespace-nowrap px-2.5 py-2 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={index} className="border-b border-border last:border-0 hover:bg-surface">
                {result.columns.map((column) => (
                  <td key={column} className="max-w-[360px] truncate px-2.5 py-1.5 font-mono text-foreground">
                    {formatCell(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.notices.length > 0 ? (
        <Notice tone="info">数据库提示：{result.notices.join("；")}</Notice>
      ) : null}
    </div>
  );
}

/** 单元格渲染：null 显式标出来（空字符串与 null 必须能区分）。 */
function formatCell(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
