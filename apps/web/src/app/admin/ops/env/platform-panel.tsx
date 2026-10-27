"use client";

import { useState, useTransition } from "react";

import { loadNeonStatusAction, loadVercelStatusAction } from "@/lib/ops/actions";
import type { NeonStatus, VercelStatus } from "@/lib/ops/env";

import { Chip, KeyValue, Notice, ResultBadge } from "../ops-ui";

/**
 * 外部平台面板（客户端）。
 *
 * ── 为什么要按钮，而不是首屏直查 ──────────────────────────────────────
 * 这两个查询都走公网（Vercel `api.vercel.com`、Neon `console.neon.tech`），
 * 单次超时 20 秒。首屏直查会让「打开运维台」这个动作在弱网下卡住十几秒，
 * 而绝大多数时候你只是来看本地配置的。
 *
 * ── 为什么不把 token 回传给页面 ───────────────────────────────────────
 * `getVercelStatus()` / `getNeonStatus()` 返回的是**结果**，token 只在
 * 服务端 `resolveVercelToken()` 内部流转。页面上只显示「来源」字符串。
 */
export function PlatformPanel({
  vercel,
  neon,
}: {
  vercel: { available: boolean; reason: string; tokenSource: string };
  neon: { available: boolean; reason: string; tokenSource: string };
}) {
  return (
    <div className="mt-2 space-y-3">
      <VercelSection availability={vercel} />
      <NeonSection availability={neon} />
    </div>
  );
}

function VercelSection({
  availability,
}: {
  availability: { available: boolean; reason: string; tokenSource: string };
}) {
  const [status, setStatus] = useState<VercelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function load() {
    setError(null);
    startTransition(async () => {
      const response = await loadVercelStatusAction();
      if (!response.ok) {
        setError(response.error ?? "查询失败，但没有返回原因。");
        return;
      }
      setStatus(response.data ?? null);
    });
  }

  return (
    <div className="rounded-xl border border-border bg-elevated p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-xs font-medium text-foreground">Vercel</h4>
          {availability.available ? (
            <Chip tone="ok" label="凭据可用" />
          ) : (
            <Chip tone="muted" label="无凭据" />
          )}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={pending || !availability.available}
          className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-xs font-medium text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {pending ? "查询中…" : "查询项目与部署"}
        </button>
      </div>

      <p className="mt-1 text-[11px] text-muted">凭据来源：{availability.tokenSource}</p>
      {!availability.available && availability.reason ? (
        <p className="mt-1 text-[11px] leading-relaxed text-warning">{availability.reason}</p>
      ) : null}

      {error ? <Notice tone="error">{error}</Notice> : null}

      {status === null ? null : !status.ok ? (
        <p className="mt-2 text-xs text-error">{status.error ?? "查询失败。"}</p>
      ) : (
        <div className="mt-2 space-y-1">
          {status.project ? (
            <>
              <KeyValue label="项目" value={`${status.project.name}（${status.project.id}）`} />
              <KeyValue label="框架" value={status.project.framework ?? "—"} />
              <KeyValue label="Root Directory" value={status.project.rootDirectory ?? "—"} />
            </>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[11px] text-muted">Git 集成：</span>
            {status.linkType === "github" ? (
              <Chip tone="ok" label="github（push 会自动部署）" />
            ) : (
              <Chip
                tone="warn"
                label={`${status.linkType ?? "未知"}（push 不会自动部署）`}
              />
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-muted">
            P8 踩过：新项目的 <code className="font-mono">link.type</code> 是{" "}
            <code className="font-mono">none</code>，于是 push 不触发部署，而本地验收全绿。
          </p>

          <KeyValue label="域名" value={status.domains.length > 0 ? status.domains.join("  ") : "—"} />

          <div className="pt-2">
            <p className="text-[11px] font-medium text-foreground">最近部署</p>
            <ul className="mt-1 space-y-1">
              {status.deployments.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                  <ResultBadge ok={item.state === "READY"} label={item.state} />
                  <span className="font-mono text-foreground">
                    {item.commitSha ? item.commitSha.slice(0, 7) : "—"}
                  </span>
                  <span className="text-muted">{item.target ?? "—"}</span>
                  <span className="truncate text-muted">{item.commitMessage ?? ""}</span>
                </li>
              ))}
              {status.deployments.length === 0 ? (
                <li className="text-[11px] text-muted">没有部署记录。</li>
              ) : null}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function NeonSection({
  availability,
}: {
  availability: { available: boolean; reason: string; tokenSource: string };
}) {
  const [status, setStatus] = useState<NeonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function load() {
    setError(null);
    startTransition(async () => {
      const response = await loadNeonStatusAction();
      if (!response.ok) {
        setError(response.error ?? "查询失败，但没有返回原因。");
        return;
      }
      setStatus(response.data ?? null);
    });
  }

  return (
    <div className="rounded-xl border border-border bg-elevated p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-xs font-medium text-foreground">Neon</h4>
          {availability.available ? (
            <Chip tone="ok" label="凭据可用" />
          ) : (
            <Chip tone="muted" label="无凭据" />
          )}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={pending || !availability.available}
          className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-xs font-medium text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {pending ? "查询中…" : "查询项目与端点"}
        </button>
      </div>

      <p className="mt-1 text-[11px] text-muted">凭据来源：{availability.tokenSource}</p>
      {!availability.available && availability.reason ? (
        <p className="mt-1 text-[11px] leading-relaxed text-warning">{availability.reason}</p>
      ) : null}

      {error ? <Notice tone="error">{error}</Notice> : null}

      {status === null ? null : !status.ok ? (
        <p className="mt-2 text-xs text-error">{status.error ?? "查询失败。"}</p>
      ) : (
        <div className="mt-2 space-y-1">
          {status.project ? (
            <>
              <KeyValue label="项目" value={`${status.project.name}（${status.project.id}）`} />
              <KeyValue label="区域" value={status.project.region ?? "—"} />
              <KeyValue label="PG 版本" value={status.project.pgVersion ? String(status.project.pgVersion) : "—"} />
            </>
          ) : null}

          <KeyValue
            label="分支"
            value={status.branches.map((b) => `${b.name}${b.primary ? "（primary）" : ""}`).join("  ") || "—"}
          />

          <div className="pt-2">
            <p className="text-[11px] font-medium text-foreground">计算端点</p>
            <ul className="mt-1 space-y-1">
              {status.endpoints.map((endpoint) => (
                <li key={endpoint.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                  <Chip
                    tone={endpoint.currentState === "active" ? "ok" : "muted"}
                    label={endpoint.currentState}
                  />
                  <span className="font-mono text-foreground">{endpoint.host}</span>
                  <span className="text-muted">{endpoint.type}</span>
                </li>
              ))}
              {status.endpoints.length === 0 ? (
                <li className="text-[11px] text-muted">没有端点。</li>
              ) : null}
            </ul>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              <code className="font-mono">idle</code> 表示计算节点已 scale-to-zero，
              下一次连接要冷启动 3–4 秒（P8 期间因此出现过{" "}
              <code className="font-mono">read ECONNRESET</code>）。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
