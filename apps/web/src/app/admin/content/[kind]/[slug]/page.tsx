import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { EntryEditor, type EntryEditorValues } from "@/components/admin/entry-editor";
import { hasDatabaseUrl } from "@/lib/admin/db";
import {
  getEntryDetail,
  listEntryTagNames,
  parseKindFilter,
  type EntryDetailRow,
} from "@/lib/admin/entries";
import { KIND_LABELS, STATUS_LABELS, type AdminStatus } from "@/lib/admin/validation";
import { formatDate } from "@/lib/format";

import { EntryStatusBar } from "./entry-status-bar";

export const metadata: Metadata = { title: "编辑内容" };

/** Next 16：`params` 也是 Promise，必须 await（或在 `use()` 里读）。 */
export type EditPageParams = Promise<{ kind: string; slug: string }>;

/**
 * 编辑页（`/admin/content/[kind]/[slug]`）。
 *
 * ── 为什么 slug 也要 `decodeURIComponent` ────────────────────────────
 * 列表页生成链接时用了 `encodeURIComponent(row.slug)`（slug 里允许 `.`，
 * 某些工具也会写出中文），Next 会把 URL 段解码后放进 `params`，但为防
 * 中间层二次编码，这里再显式解一次；失败则原样使用，不抛错。
 *
 * ── 为什么外壳只画面包屑 ─────────────────────────────────────────────
 * `cacheComponents` 下 `params` 是运行时数据，顶层 await 会让整页变成
 * 阻塞式预渲染（`next build` 报 blocking-prerender-runtime）。所以外壳只
 * 画「不依赖参数的标题区」，真正的表单在 `<Suspense>` 里补。
 */
export default function EditEntryPage({ params }: { params: EditPageParams }) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <nav aria-label="面包屑" className="text-xs text-muted">
        <Link href="/admin/content" className="hover:text-foreground">
          内容
        </Link>
        <span className="mx-1.5 text-muted-deep">/</span>
        <span>编辑</span>
      </nav>

      <Suspense fallback={<EditorSkeleton />}>
        <EditEntryBody params={params} />
      </Suspense>
    </div>
  );
}

async function EditEntryBody({ params }: { params: EditPageParams }) {
  const raw = await params;
  const kind = parseKindFilter(raw.kind);
  const slug = safeDecode(raw.slug);

  // kind 不在四个枚举里（URL 被手改），当作不存在处理。
  if (kind === "all") notFound();

  if (!hasDatabaseUrl()) {
    return (
      <p className="mt-6 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        未配置 DATABASE_URL，无法读取内容。
      </p>
    );
  }

  // 两段串行：标签是按 entry id 查的，id 得先拿到 entry 才知道。
  // 不做 `Promise.all` 是因为第二步依赖第一步的结果，并发只会多查一次。
  const entry = await getEntryDetail(kind, slug);
  if (!entry) notFound();

  const tags = await listEntryTagNames(entry.id);

  return (
    <>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
            {entry.title || "(无标题)"}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>{KIND_LABELS[entry.kind]}</span>
            <span className="font-mono">{entry.slug}</span>
            <span className="tabular-nums">v{entry.version}</span>
            <span className="tabular-nums">更新于 {formatDate(entry.updatedAt.toISOString())}</span>
            <span className="tabular-nums">创建于 {formatDate(entry.createdAt.toISOString())}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/admin/content/${entry.kind}/${encodeURIComponent(entry.slug)}/revisions`}
            className="rounded-xl border border-border px-3.5 py-2 text-sm text-muted transition-colors hover:text-foreground"
          >
            版本历史（{entry.version}）
          </Link>
          <Link
            href="/admin/content"
            className="rounded-xl border border-border px-3.5 py-2 text-sm text-muted transition-colors hover:text-foreground"
          >
            返回列表
          </Link>
        </div>
      </header>

      <EntryStatusBar
        entryId={entry.id}
        expectedVersion={String(entry.version)}
        status={entry.publishStatus}
        displayDate={entry.displayDate}
      />

      <EntryEditor
        mode="edit"
        entryId={entry.id}
        expectedVersion={String(entry.version)}
        values={toEditorValues(entry, tags)}
        publishStatus={STATUS_LABELS[entry.publishStatus as AdminStatus] ?? entry.publishStatus}
      />
    </>
  );
}

/** 把库里的行摊成编辑器初值。缺字段一律给空串，绝不给 `undefined`（受控输入会警告）。 */
function toEditorValues(entry: EntryDetailRow, tags: string[]): EntryEditorValues {
  const data = entry.data;
  return {
    kind: entry.kind,
    slug: entry.slug,
    title: entry.title,
    summary: entry.summary,
    bodyMd: entry.bodyMd,
    tags: tags.join(", "),
    displayDate: entry.displayDate ?? "",
    category: stringOf(data.category, "未分类"),
    cover: stringOf(data.cover, ""),
    mood: stringOf(data.mood, ""),
    techStack: arrayOf(data.techStack).join(", "),
    projectStatus: stringOf(data.status, "in-progress"),
    period: stringOf(data.period, ""),
    role: stringOf(data.role, ""),
    github: stringOf(data.github, ""),
    demo: stringOf(data.demo, ""),
    article: stringOf(data.article, ""),
    featured: entry.featured,
    sortOrder: String(entry.sortOrder),
    horizon: stringOf(data.horizon, "short"),
    goalStatus: stringOf(data.status, "planned"),
    progress: String(numberOf(data.progress, 0)),
    milestones: milestonesOf(data.milestones),
  };
}

function stringOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function arrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function milestonesOf(value: unknown): { title: string; done: boolean }[] {
  if (!Array.isArray(value)) return [];
  const result: { title: string; done: boolean }[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : "";
    if (!title) continue;
    result.push({ title, done: record.done === true });
  }
  return result;
}

/** `decodeURIComponent` 对非法转义会抛 `URIError`，这里兜住并回退原串。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function EditorSkeleton() {
  return (
    <div className="mt-6 space-y-3" aria-busy="true">
      <div className="h-9 w-64 animate-pulse rounded-lg bg-surface" />
      <div className="h-24 animate-pulse rounded-xl border border-border bg-elevated" />
      <div className="h-[520px] animate-pulse rounded-xl border border-border bg-elevated" />
    </div>
  );
}
