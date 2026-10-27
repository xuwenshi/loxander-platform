"use client";

import { useState, useTransition } from "react";

import { runAllChecksAction, runCheckAction, probeSpawnAction } from "@/lib/ops/actions";
import type { CheckId, CheckResult, SpawnProbe } from "@/lib/ops/runner";

import { Chip, Notice, ResultBadge, ScoreBadge } from "../ops-ui";

/**
 * 检查面板（客户端）。
 *
 * ── 为什么按钮是「一项一项跑」而不是进页面就跑 ────────────────────────
 * 因为其中「路由巡检」要发 16 个真实 HTTP 请求（含 `/admin` 的 307），
 * 在页面上无脑跑会让每次打开都产生一串服务器日志。所以默认只显示
 * 「还没跑」，由运维者按需点。这与 `/admin/settings`（纯静态自检、
 * 打开即算）是不同取舍，理由就写在这里。
 *
 * ── 为什么结果不持久化 ───────────────────────────────────────────────
 * 检查结果是「这一刻的状态」，存下来反而骗人：十分钟后数据库可能已经不通了。
 * 每次点都重新算，页面上明确标出耗时。
 */
export function ChecksPanel({
  initial,
  baseUrl,
  hasDatabaseUrl: dbReady,
}: {
  initial: CheckResult[];
  baseUrl: string;
  hasDatabaseUrl: boolean;
}) {
  const [results, setResults] = useState<CheckResult[]>(initial);
  const [running, setRunning] = useState<CheckId | "all" | null>(null);
  const [spawn, setSpawn] = useState<SpawnProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function replaceResult(next: CheckResult) {
    setResults((current) => {
      const index = current.findIndex((r) => r.id === next.id);
      if (index === -1) return [...current, next];
      const copy = current.slice();
      copy[index] = next;
      return copy;
    });
  }

  function runOne(id: CheckId) {
    setError(null);
    setRunning(id);
    startTransition(async () => {
      const response = await runCheckAction(id, baseUrl);
      setRunning(null);
      if (!response.ok) {
        setError(response.error ?? "检查失败，但没有返回原因。");
        return;
      }
      if (response.data) replaceResult(response.data);
    });
  }

  function runAll() {
    setError(null);
    setRunning("all");
    startTransition(async () => {
      const response = await runAllChecksAction();
      setRunning(null);
      if (!response.ok) {
        setError(response.error ?? "检查失败，但没有返回原因。");
        return;
      }
      if (response.data) setResults(response.data);
    });
  }

  function probeSpawnCapability() {
    startTransition(async () => {
      const response = await probeSpawnAction();
      if (response.ok && response.data) setSpawn(response.data);
    });
  }

  const allPassed = results.length > 0 && results.every((r) => r.ok);

  return (
    <div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runAll}
          disabled={pending}
          className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {running === "all" ? "运行中…" : "跑全部本地检查"}
        </button>

        <span className="text-[11px] text-muted">
          {allPassed ? (
            <Chip tone="ok" label="全部通过" />
          ) : results.length === 0 ? (
            <Chip tone="muted" label="还没跑" />
          ) : (
            <Chip tone="warn" label={`${results.filter((r) => !r.ok).length} 项有问题`} />
          )}
        </span>

        <span className="text-[11px] text-muted">
          「路由巡检」需要单独点（会发 16 个真实请求）
        </span>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <ul className="mt-4 space-y-3">
        {results.map((result) => (
          <li key={result.id} className="rounded-xl border border-border bg-elevated">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-foreground">{result.label}</span>
                <ResultBadge ok={result.ok} />
                <ScoreBadge passed={result.passed} total={result.total} />
                <span className="font-mono text-[11px] text-muted">{result.elapsedMs}ms</span>
              </div>
              <button
                type="button"
                onClick={() => runOne(result.id as CheckId)}
                disabled={pending}
                className="text-[11px] text-accent underline-offset-2 hover:underline disabled:opacity-50"
              >
                {running === result.id ? "运行中…" : "重跑"}
              </button>
            </div>

            {result.error ? (
              <p className="px-3 py-2 text-xs text-error">{result.error}</p>
            ) : (
              <ul className="divide-y divide-border">
                {result.lines.map((line, index) => (
                  <li
                    // eslint-disable-next-line react/no-array-index-key
                    key={`${line.name}-${index}`}
                    className="flex flex-wrap items-start gap-2 px-3 py-1.5"
                  >
                    <span className="w-4 shrink-0 pt-0.5 text-[11px]">
                      {line.ok ? (
                        <span className="text-success" aria-label="通过">
                          ✓
                        </span>
                      ) : (
                        <span className="text-error" aria-label="失败">
                          ✕
                        </span>
                      )}
                    </span>
                    <span className="min-w-[120px] shrink-0 font-mono text-[11px] text-foreground">
                      {line.name}
                    </span>
                    <span className="min-w-0 flex-1 break-all text-[11px] leading-relaxed text-muted">
                      {line.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <RouteCheckNote baseUrl={baseUrl} />

      <SpawnSection
        spawn={spawn}
        dbReady={dbReady}
        onProbe={probeSpawnCapability}
        disabled={pending}
      />
    </div>
  );
}

/** 路由巡检的目标地址说明 —— 让人知道这 16 个请求打到哪。 */
function RouteCheckNote({ baseUrl }: { baseUrl: string }) {
  return (
    <p className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-[11px] leading-relaxed text-muted">
      路由巡检的目标：<code className="font-mono text-foreground">{baseUrl}</code>
      。如果这里显示的是线上域名而你想测本机，改 <code className="font-mono">NEXT_PUBLIC_SITE_URL</code> 后重启。
    </p>
  );
}

/** 子进程能力：为什么「跑脚本」只能去终端。 */
function SpawnSection({
  spawn,
  dbReady,
  onProbe,
  disabled,
}: {
  spawn: SpawnProbe | null;
  dbReady: boolean;
  onProbe: () => void;
  disabled: boolean;
}) {
  return (
    <section className="mt-8 rounded-xl border border-border bg-elevated p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">子进程能力</h3>
        <button
          type="button"
          onClick={onProbe}
          disabled={disabled}
          className="text-[11px] text-accent underline-offset-2 hover:underline disabled:opacity-50"
        >
          实测一次
        </button>
      </div>

      <p className="mt-1 text-xs leading-relaxed text-muted">
        运维台**不**用子进程跑脚本。这不是偷懒 —— 本机沙箱下 `spawn` 直接抛
        EPERM，Vercel 的 Serverless 运行时也不提供子进程。而 `preflight.mjs`
        内部正是用 `spawnSync` 跑 tsc 与全部单测的，所以即使 import 它也会失败。
      </p>

      {spawn ? (
        <p className="mt-2 text-xs">
          {spawn.available ? (
            <Chip tone="ok" label={`可 spawn（${spawn.elapsedMs}ms）`} />
          ) : (
            <>
              <Chip tone="warn" label={spawn.code ?? "不可用"} />
              {spawn.error ? <span className="ml-2 text-muted">{spawn.error}</span> : null}
            </>
          )}
        </p>
      ) : (
        <p className="mt-2 text-[11px] text-muted">还没实测。点「实测一次」拿证据。</p>
      )}

      <p className="mt-2 text-[11px] text-muted">
        数据库连接：{dbReady ? "已配置（只读）" : "未配置"}。
      </p>
    </section>
  );
}
