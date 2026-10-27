"use client";

import { useState, useTransition } from "react";

import { probeRoutesAction } from "@/lib/ops/actions";
import type { RouteProbe } from "@/lib/ops/runtime";

import { Chip, Notice, ResultBadge, ScoreBadge } from "../ops-ui";

/**
 * 路由巡检面板（客户端）。
 *
 * ── 为什么这一块必须由人点 ────────────────────────────────────────────
 * 16 个真实 HTTP 请求。在本机上它请求的是**自己这个进程**，如果放在首屏
 * 渲染路径里，巡检请求会和页面渲染抢同一个 Node 事件循环，耗时列全是噪声。
 * 线上同理：每次打开运维台就产生 16 条访问日志，没有意义。
 *
 * ── 为什么结果不持久化 ────────────────────────────────────────────────
 * 巡检结果是「这一刻的状态」。存下来十分钟后就变成谎言。
 */
export function RuntimePanel({
  baseUrl,
  paths,
}: {
  baseUrl: string;
  paths: { path: string; expect: number }[];
}) {
  const [results, setResults] = useState<RouteProbe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function runProbe() {
    setError(null);
    startTransition(async () => {
      const response = await probeRoutesAction(baseUrl);
      if (!response.ok) {
        setError(response.error ?? "巡检失败，但没有返回原因。");
        return;
      }
      setResults(response.data ?? []);
    });
  }

  const passed = results ? results.filter((item) => item.pass).length : 0;
  const total = results ? results.length : paths.length;

  return (
    <section className="mt-4 rounded-xl border border-border bg-elevated p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">路由巡检</h3>
          {results ? <ScoreBadge passed={passed} total={total} /> : <Chip tone="muted" label="还没跑" />}
        </div>
        <button
          type="button"
          onClick={runProbe}
          disabled={pending}
          className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {pending ? "巡检中…" : `巡检 ${paths.length} 条路由`}
        </button>
      </div>

      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        目标：<code className="font-mono text-foreground">{baseUrl}</code>
        。串行请求，<code className="font-mono">redirect: &quot;manual&quot;</code> ——
        不这样的话 <code className="font-mono">/admin</code> 会被跟随成
        <code className="font-mono">/login</code> 的 200，看不出守卫在工作。
      </p>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {results === null ? (
        <p className="mt-2 text-xs text-muted">还没跑。点上面的按钮。</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border bg-surface text-left text-muted">
                <th scope="col" className="px-2.5 py-2 font-medium">路由</th>
                <th scope="col" className="px-2.5 py-2 font-medium">状态</th>
                <th scope="col" className="px-2.5 py-2 font-medium">期望</th>
                <th scope="col" className="px-2.5 py-2 font-medium">耗时</th>
                <th scope="col" className="px-2.5 py-2 font-medium">字节</th>
                <th scope="col" className="px-2.5 py-2 font-medium">缓存</th>
              </tr>
            </thead>
            <tbody>
              {results.map((item) => (
                <tr key={item.path} className="border-b border-border last:border-0 hover:bg-surface">
                  <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-foreground">
                    {item.path}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5">
                    <ResultBadge ok={item.pass} label={item.status === null ? "ERR" : String(item.status)} />
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-muted">{item.expect}</td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-muted">{item.ms}ms</td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-muted">
                    {item.bytes ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px] text-muted">
                    {item.vcache ? `vcache=${item.vcache}` : ""}
                    {item.vcache && item.cache ? " " : ""}
                    {item.cache ? `next=${item.cache}` : ""}
                    {!item.vcache && !item.cache ? "—" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {results && results.some((item) => item.error) ? (
        <ul className="mt-2 space-y-1">
          {results
            .filter((item) => item.error)
            .map((item) => (
              <li key={item.path} className="text-[11px] text-error">
                <code className="font-mono">{item.path}</code>：{item.error}
              </li>
            ))}
        </ul>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        缓存列里 <code className="font-mono">vcache=HIT</code> 说明这条命中了 Vercel
        边缘缓存 —— 判定 404 时必须保证缓存 <strong className="text-foreground">MISS</strong>，
        否则你看到的是旧响应（P7/P8 都在这上面栽过）。
      </p>
    </section>
  );
}
