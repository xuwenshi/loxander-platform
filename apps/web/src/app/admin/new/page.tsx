import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";

import { EntryEditor, type EntryEditorValues } from "@/components/admin/entry-editor";
import { KIND_LABELS } from "@/lib/admin/validation";
import { ENTRY_KINDS, isEntryKind, type EntryKind } from "@loxander/content-core";

export const metadata: Metadata = { title: "新建内容" };

/**
 * 新建内容（`/admin/new`）。
 *
 * ── 为什么内容类型放在 URL 上而不是表单里选 ──────────────────────────
 * 四个 kind 的表单字段完全不同（blog 有分类/封面，goals 有里程碑……）。
 * 用 `?kind=blog` 让服务端一次就渲染出对应那套字段，切换类型就是一次导航，
 * 不需要「先渲染四套再靠 JS 显示一套」。代价是切换会丢已填内容 —— 但新建页
 * 本来就还没填什么，而编辑页的类型是固定的（不允许改 kind）。
 *
 * ── 为什么页面是静态外壳 ─────────────────────────────────────────────
 * 开了 `cacheComponents`：`searchParams` 与 `new Date()` 都是运行时数据，
 * 在页面顶层 await/求值会让整页退化成阻塞式预渲染，`next build` 报
 * blocking-prerender-runtime。所以外壳只画标题与类型切换，真正的表单在
 * `<Suspense>` 里补。
 */
export default function NewEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">新建内容</h1>
          <p className="mt-1 text-sm text-muted">
            新建的内容一律先存为草稿。发布是独立流程（校验 → 预览 → 确认），
            避免误点一次就把半成品推上线。
          </p>
        </div>
        <Link
          href="/admin/content"
          className="rounded-xl border border-border px-3.5 py-2 text-sm text-muted transition-colors hover:text-foreground"
        >
          返回列表
        </Link>
      </header>

      <Suspense fallback={<EditorSkeleton />}>
        <NewEntryBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function NewEntryBody({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  // `blankValues()` 里 `todayInEast8()` 会读 `new Date()`。开了 `cacheComponents`
  // 后「当前时间」是不稳定值，在预渲染阶段求值会报 blocking-prerender-current-time
  // （实测：Route "/admin/new" 的 stderr 告警）。`connection()` 把这段子树钉到
  // 请求时刻，顺带让 `searchParams` 的读取也走运行时。
  // 文档：node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md
  await connection();

  const params = await searchParams;
  const raw = params.kind ?? "blog";
  const kind: EntryKind = isEntryKind(raw) ? raw : "blog";

  return (
    <>
      <KindSwitcher current={kind} />
      <EntryEditor
        mode="create"
        entryId=""
        expectedVersion="1"
        values={blankValues(kind)}
        publishStatus="draft"
      />
    </>
  );
}

/** 类型切换：四个链接，当前项高亮。 */
function KindSwitcher({ current }: { current: EntryKind }) {
  return (
    <nav aria-label="内容类型" className="mt-5 flex flex-wrap gap-2">
      {ENTRY_KINDS.map((kind) => (
        <Link
          key={kind}
          href={`/admin/new?kind=${kind}`}
          aria-current={kind === current ? "page" : undefined}
          className={
            kind === current
              ? "rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-[var(--on-accent)]"
              : "rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
          }
        >
          {KIND_LABELS[kind]}
        </Link>
      ))}
    </nav>
  );
}

/**
 * 空表单的初值。
 *
 * `displayDate` 预填「今天」——按东八区算，因为这是本项目全部日期语义的基准
 * （P2 导入器用 `date + 'T00:00:00+08:00'` 落 `published_at`）。
 * 用 `toISOString().slice(0,10)` 会在东八区凌晨 0—8 点给出前一天。
 */
function blankValues(kind: EntryKind): EntryEditorValues {
  return {
    kind,
    slug: "",
    title: "",
    summary: "",
    bodyMd: "",
    tags: "",
    displayDate: todayInEast8(),
    category: "未分类",
    cover: "",
    mood: "",
    techStack: "",
    projectStatus: "in-progress",
    period: "",
    role: "",
    github: "",
    demo: "",
    article: "",
    featured: false,
    sortOrder: "999",
    horizon: "short",
    goalStatus: "planned",
    progress: "0",
    milestones: [],
  };
}

function todayInEast8(): string {
  // en-CA 的日期格式恰好是 YYYY-MM-DD。
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function EditorSkeleton() {
  return (
    <div className="mt-6 space-y-3" aria-busy="true">
      <div className="h-9 w-64 animate-pulse rounded-lg bg-surface" />
      <div className="h-[520px] animate-pulse rounded-xl border border-border bg-elevated" />
    </div>
  );
}
