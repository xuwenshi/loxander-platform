import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { hasDatabaseUrl } from "@/lib/admin/db";
import { siteConfig } from "@/lib/site";
import {
  DEFAULT_ROUTE_PATHS,
  checkCssArtifacts,
  checkVersionConsistency,
  getBuildInfo,
  probeDatabase,
  readGitHead,
} from "@/lib/ops/runtime";

import { Chip, KeyValue, ResultBadge, SectionSkeleton } from "../ops-ui";
import { RuntimePanel } from "./runtime-panel";

export const metadata: Metadata = { title: "运行态" };

/**
 * 运行态页（`/admin/ops/runtime`）。
 *
 * ── 首屏算什么、不算什么 ─────────────────────────────────────────────
 * 首屏只做「读文件 + 连一次库 + 查一次线上版本」：git HEAD、构建 ID、
 * 进程信息、CSS 产物、数据库连通性（一次 `select 1`）、线上 `/api/health`
 * 的 version。这些是确定要看的，且都很便宜。
 *
 * **路由巡检不在首屏跑**：16 个真实 HTTP 请求会把访问日志打满，而且
 * 在本机上它会请求自己（同一个进程），把「路由巡检」与「页面渲染」
 * 混在一起会让耗时数据失真。留给按钮。
 *
 * ── 为什么版本比对结果在服务端算好再传给客户端 ───────────────────────
 * 它是一个 `fetch`，服务端算完就是纯数据。把 Promise 传进客户端组件
 * 虽然 Next 支持（`use()`），但会多一层「什么时候 resolve」的心智负担，
 * 而这个值不需要交互 —— 没有理由拖到客户端。
 */
export default function OpsRuntimePage() {
  return (
    <Suspense fallback={<SectionSkeleton rows={6} />}>
      <OpsRuntimeBody />
    </Suspense>
  );
}

async function OpsRuntimeBody() {
  // 全是「当前进程看到的东西」，静态烘焙会骗人。
  await connection();

  const baseUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? siteConfig.url).replace(/\/+$/, "");
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const dbReady = databaseUrl.length > 0 && hasDatabaseUrl();

  const head = readGitHead();
  const build = getBuildInfo();
  const css = checkCssArtifacts();

  // 这两件事都可能失败，而失败本身就是结论 —— 不能让它把整页打崩。
  const db = dbReady
    ? await probeDatabase(databaseUrl).catch((error: unknown) => ({
        ok: false,
        latencyMs: 0,
        serverVersion: null,
        readOnly: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    : null;

  const version = await checkVersionConsistency({ remoteUrl: baseUrl }).catch((error: unknown) => ({
    localHead: head ? head.shortSha : null,
    buildId: build.buildId,
    remoteVersion: null,
    remoteUrl: baseUrl,
    headMatchesRemote: null,
    verdict: `版本比对失败：${error instanceof Error ? error.message : String(error)}`,
  }));

  return (
    <div>
      <h2 className="mt-6 font-serif text-lg font-medium text-foreground">运行态</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        这一页全部读「当前进程能看到的东西」：<code className="font-mono">.git/HEAD</code>、
        <code className="font-mono">.next/BUILD_ID</code>、<code className="font-mono">.next/static/css</code>、
        以及一次真实的数据库往返。不用 <code className="font-mono">child_process</code>
        —— 本机沙箱下 <code className="font-mono">spawn</code> 抛 EPERM，线上也不给子进程。
      </p>

      {/* ---------------- 进程与构建 ---------------- */}
      <section className="mt-6 rounded-xl border border-border bg-elevated p-3">
        <h3 className="text-sm font-medium text-foreground">进程与构建</h3>
        <div className="mt-2 space-y-1">
          <KeyValue label="NODE_ENV" value={build.nodeEnv} />
          <KeyValue label="Node" value={build.nodeVersion} />
          <KeyValue label="构建 ID" value={build.buildId ?? "读不到（没有构建产物）"} />
          <KeyValue label="应用根" value={build.appRoot} />
          <KeyValue
            label="运行环境"
            value={
              build.vercel ? `Vercel（部署 ${build.vercelDeploymentId ?? "未知"}）` : "本机 / 非 Vercel"
            }
          />
          {build.vercelCommitSha ? (
            <KeyValue label="Vercel 注入的提交" value={build.vercelCommitSha.slice(0, 7)} />
          ) : null}
        </div>
      </section>

      {/* ---------------- git ---------------- */}
      <section className="mt-4 rounded-xl border border-border bg-elevated p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">git</h3>
          {head ? <Chip tone="ok" label={head.shortSha} /> : <Chip tone="muted" label="读不到" />}
        </div>
        {head ? (
          <div className="mt-2 space-y-1">
            <KeyValue label="分支" value={head.branch ?? "（detached HEAD）"} />
            <KeyValue label="完整 sha" value={head.sha} />
            <KeyValue
              label="来源"
              value={head.source === "loose" ? ".git/refs 散文件" : ".git/packed-refs"}
            />
          </div>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-muted">
            读不到 <code className="font-mono">.git/HEAD</code>。生产部署没有{" "}
            <code className="font-mono">.git</code> 目录，这是正常的 —— 那种情况下只能看下面的线上版本。
          </p>
        )}
      </section>

      {/* ---------------- 数据库 ---------------- */}
      <section className="mt-4 rounded-xl border border-border bg-elevated p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">数据库</h3>
          {db === null ? (
            <Chip tone="muted" label="未配置" />
          ) : (
            <>
              <ResultBadge ok={db.ok} label={db.ok ? "连通" : "不通"} />
              <Chip
                tone={db.readOnly ? "ok" : "warn"}
                label={db.readOnly ? "会话只读" : "会话可写"}
              />
              <span className="font-mono text-[11px] text-muted">{db.latencyMs}ms</span>
            </>
          )}
        </div>
        {db === null ? (
          <p className="mt-2 text-xs text-muted">未配置 DATABASE_URL，无法探测。</p>
        ) : (
          <div className="mt-2 space-y-1">
            {db.serverVersion ? <KeyValue label="服务端" value={db.serverVersion} /> : null}
            {db.error ? <p className="text-xs text-error">{db.error}</p> : null}
            <p className="pt-1 text-[11px] leading-relaxed text-muted">
              「会话只读」是<strong className="text-foreground">向数据库本身求证</strong>的（读{" "}
              <code className="font-mono">current_setting(&apos;default_transaction_read_only&apos;)</code>
              ），不是相信自己写的连接参数。这里若显示「会话可写」，说明只读防线出问题了。
            </p>
          </div>
        )}
      </section>

      {/* ---------------- CSS 产物 ---------------- */}
      <section className="mt-4 rounded-xl border border-border bg-elevated p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">CSS 产物</h3>
          <ResultBadge ok={css.ok} />
          <span className="font-mono text-[11px] text-muted">
            {css.files} 文件 / {css.totalBytes} B
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">{css.detail}</p>
        {css.missing.length > 0 ? (
          <p className="mt-1 break-all font-mono text-[11px] text-error">
            缺失：{css.missing.join("  ")}
          </p>
        ) : null}
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          P7 踩过：生产构建成功、页面 200、但 CSS 里一条工具类都没有（整站无样式），
          而所有常规闸门都不响。这条检查就是为了让那种情况至少在一处响。
        </p>
      </section>

      {/* ---------------- 版本一致性 ---------------- */}
      <section className="mt-4 rounded-xl border border-border bg-elevated p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">版本一致性</h3>
          {version.headMatchesRemote === null ? (
            <Chip tone="warn" label="无法判断" />
          ) : version.headMatchesRemote ? (
            <Chip tone="ok" label="一致" />
          ) : (
            <Chip tone="error" label="不一致" />
          )}
        </div>
        <div className="mt-2 space-y-1">
          <KeyValue label="本机 HEAD" value={version.localHead ?? "读不到"} />
          <KeyValue label="构建 ID" value={version.buildId ?? "读不到"} />
          <KeyValue label="线上版本" value={version.remoteVersion ?? "读不到"} />
          <KeyValue label="比对地址" value={version.remoteUrl} />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">{version.verdict}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          P8 踩过：修软 404 的提交 <code className="font-mono">6d2adee</code> 从未被部署，
          而所有本地验收全绿（验收跑的是本地构建产物）。这块把当时那次手工比对固化下来。
        </p>
      </section>

      {/* ---------------- 路由巡检（客户端按钮） ---------------- */}
      <RuntimePanel baseUrl={baseUrl} paths={DEFAULT_ROUTE_PATHS} />
    </div>
  );
}
