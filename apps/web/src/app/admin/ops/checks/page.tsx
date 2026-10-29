import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { hasDatabaseUrl } from "@/lib/admin/db";
import { runAllLocalChecks } from "@/lib/ops/runner";
import { siteConfig } from "@/lib/site";

import { SectionSkeleton, Notice } from "../ops-ui";
import { ChecksPanel } from "./checks-panel";

export const metadata: Metadata = { title: "检查" };

/**
 * 检查页（`/admin/ops/checks`）。
 *
 * ── 为什么服务端先把「本地五项」跑一遍 ───────────────────────────────
 * 这五项（环境 / 迁移 / 构建 / CSS / 仓库）全是读文件系统的进程内检查，
 * 加起来几十毫秒。打开页面就有结果，比「打开→点按钮→等」少一次往返，
 * 也避免页面初次渲染时显示一堆「还没跑」让人误以为坏了。
 *
 * ── 为什么「路由巡检」不在首屏跑 ─────────────────────────────────────
 * 它要发 16 个真实 HTTP 请求（其中 `/admin` 期望 307，必须
 * `redirect: "manual"` 才拿得到），既慢又会污染访问日志。所以留成按钮，
 * 由人显式触发 —— 这条理由同时写在 `checks-panel.tsx` 里。
 */
export default function OpsChecksPage() {
  return (
    <Suspense fallback={<SectionSkeleton rows={6} />}>
      <OpsChecksBody />
    </Suspense>
  );
}

async function OpsChecksBody() {
  // 读的是「当前进程看到的文件系统与 env」，静态烘焙会骗人。
  await connection();

  // 巡检目标：优先 NEXT_PUBLIC_SITE_URL（与 lib/site.ts 同源），否则线上域名。
  const baseUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? siteConfig.url).replace(/\/+$/, "");

  let initial: Awaited<ReturnType<typeof runAllLocalChecks>> = [];
  let error: string | null = null;
  try {
    initial = await runAllLocalChecks();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  return (
    <div>
      <h2 className="mt-6 font-serif text-lg font-medium text-foreground">检查</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        全部检查都在**本进程内**执行：读文件系统、读数据库、发 HTTP 请求，不起子进程。
        需要子进程的（tsc、全部单测、Playwright、回滚演练、Markdown 导出）在下面的
        「只能去终端跑」里逐条列出。
      </p>

      {error ? <Notice tone="error">首屏检查执行失败：{error}</Notice> : null}

      <ChecksPanel initial={initial} baseUrl={baseUrl} hasDatabaseUrl={hasDatabaseUrl()} />
    </div>
  );
}
