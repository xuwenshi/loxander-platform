import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { buildSettingsReport } from "@/lib/admin/settings";
import { getEnvMatrix, getNeonStatus, getVercelStatus } from "@/lib/ops/env";

import { Chip, KeyValue, Notice, SectionSkeleton } from "../ops-ui";
import { PlatformPanel } from "./platform-panel";

export const metadata: Metadata = { title: "环境与平台" };

/**
 * 环境与平台页（`/admin/ops/env`）。
 *
 * ── 配置矩阵为什么复用 `buildSettingsReport()` ────────────────────────
 * `/admin/settings` 已经在做同一件事（读 env → 脱敏 → 判状态）。
 * 运维台再写一份就会出现两个真相源，改了一处忘了另一处 —— 那正是
 * 「配置项显示已配、代码里却没人读」这类 bug 的温床。
 * 所以这里只补 `buildSettingsReport()` 没有的部分：**外部平台能不能连**。
 *
 * ── 为什么平台状态由客户端按钮触发 ────────────────────────────────────
 * Vercel / Neon 的查询要发外部 HTTPS 请求（20s 超时）。首屏就查会让
 * 打开运维台变成一次「跨国往返」，而且没配 token 时纯属浪费。
 * 配置矩阵是本地读 env，零成本，所以留在首屏。
 */
export default function OpsEnvPage() {
  return (
    <Suspense fallback={<SectionSkeleton rows={6} />}>
      <OpsEnvBody />
    </Suspense>
  );
}

async function OpsEnvBody() {
  await connection();

  const matrix = getEnvMatrix();
  const report = matrix.report;

  return (
    <div>
      <h2 className="mt-6 font-serif text-lg font-medium text-foreground">环境与平台</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        上半部分是**本地配置矩阵**（读 <code className="font-mono">process.env</code>，脱敏后展示），
        与 <a href="/admin/settings" className="text-accent underline-offset-2 hover:underline">设置页</a>
        共用同一份判定逻辑；下半部分是**外部平台连通性**，要发真实 HTTPS 请求，由按钮触发。
      </p>

      {/* ---------------- 运行时 ---------------- */}
      <section className="mt-6 rounded-xl border border-border bg-elevated p-3">
        <h3 className="text-sm font-medium text-foreground">运行时</h3>
        <div className="mt-2 space-y-1">
          <KeyValue label="NODE_ENV" value={report.environment.nodeEnv} />
          <KeyValue label="CONTENT_SOURCE" value={report.environment.contentSource} />
          <KeyValue label="版本" value={report.environment.version} />
        </div>
      </section>

      {/* ---------------- 配置矩阵 ---------------- */}
      <section className="mt-4">
        <h3 className="text-sm font-medium text-foreground">配置项</h3>
        <ul className="mt-2 space-y-2">
          {report.configs.map((item) => (
            <li key={item.key} className="rounded-xl border border-border bg-elevated p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium text-foreground">{item.key}</span>
                <ConfigBadge state={item.state} />
                <span className="font-mono text-[11px] text-muted">{item.summary}</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">{item.purpose}</p>
              {item.hint ? (
                <p className="mt-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] leading-relaxed text-warning">
                  {item.hint}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {/* ---------------- 能力开关 ---------------- */}
      <section className="mt-4">
        <h3 className="text-sm font-medium text-foreground">能力开关</h3>
        <ul className="mt-2 space-y-2">
          {report.capabilities.map((item) => (
            <li key={item.name} className="rounded-xl border border-border bg-elevated p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-foreground">{item.name}</span>
                {item.enabled ? <Chip tone="ok" label="已启用" /> : <Chip tone="muted" label="未启用" />}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">{item.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------------- 外部平台 ---------------- */}
      <section className="mt-4">
        <h3 className="text-sm font-medium text-foreground">外部平台</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          这一块会真的去问 Vercel 与 Neon。没配 token 时如实报「不可用」而不是假装成功。
        </p>
        <PlatformPanel
          vercel={matrix.platforms.vercel}
          neon={matrix.platforms.neon}
        />
      </section>

      <Notice tone="info">
        想改这些配置？线上在 Vercel 项目的 Environment Variables 里改，本机改{" "}
        <code className="font-mono">loxander-platform/.env</code>。改完都要重启进程才生效 ——
        Next 在构建期就把一部分 env 内联进产物了。
      </Notice>
    </div>
  );
}

function ConfigBadge({ state }: { state: "ok" | "missing" | "weak" | "unused" }) {
  if (state === "ok") return <Chip tone="ok" label="已配置" />;
  if (state === "weak") return <Chip tone="warn" label="偏弱" />;
  if (state === "unused") return <Chip tone="warn" label="配了但没人读" />;
  return <Chip tone="muted" label="未配置" />;
}
