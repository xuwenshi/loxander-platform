import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { hasDatabaseUrl } from "@/lib/admin/db";
import {
  getEntryDetail,
  listRevisions,
  parseKindFilter,
  type RevisionRow,
} from "@/lib/admin/entries";
import { KIND_LABELS } from "@/lib/admin/validation";
import { formatDate } from "@/lib/format";

import { RestoreRevisionButton } from "./restore-revision-button";

export const metadata: Metadata = { title: "版本历史" };

export type RevisionsPageParams = Promise<{ kind: string; slug: string }>;

/**
 * 版本历史（`/admin/content/[kind]/[slug]/revisions`）。
 *
 * ── 只列不「对比」 ───────────────────────────────────────────────────
 * 方案 §9.7 只要求「版本历史 + 恢复历史版本」，没要求 diff 视图。这里把
 * 每一版的变更说明、时间、作者列出来，够管理员判断该回哪一版；真正的
 * 逐行 diff 是另一个功能（需要存 diff 而不是全量快照，与「快照必须完整
 * 可还原」冲突），留到以后单独设计。
 *
 * ── 为什么恢复按钮是客户端组件、列表是服务端 ─────────────────────────
 * 列表是纯展示（不需要交互），服务端渲染一次就够；恢复按钮要
 * `useActionState` 拿返回值 + 二次确认，必须客户端。两者分开后，
 * 整张表不会被拖进客户端 bundle。
 */
export default function RevisionsPage({ params }: { params: RevisionsPageParams }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <nav aria-label="面包屑" className="text-xs text-muted">
        <Link href="/admin/content" className="hover:text-foreground">
          内容
        </Link>
        <span className="mx-1.5 text-muted-deep">/</span>
        <span>版本历史</span>
      </nav>

      <Suspense fallback={<ListSkeleton />}>
        <RevisionsBody params={params} />
      </Suspense>
    </div>
  );
}

async function RevisionsBody({ params }: { params: RevisionsPageParams }) {
  const raw = await params;
  const kind = parseKindFilter(raw.kind);
  const slug = safeDecode(raw.slug);

  if (kind === "all") notFound();

  if (!hasDatabaseUrl()) {
    return (
      <p className="mt-6 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        未配置 DATABASE_URL，无法读取版本历史。
      </p>
    );
  }

  const entry = await getEntryDetail(kind, slug);
  if (!entry) notFound();

  const revisions = await listRevisions(entry.id);

  return (
    <>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
            版本历史
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>{KIND_LABELS[entry.kind]}</span>
            <span className="truncate">{entry.title || "(无标题)"}</span>
            <span className="tabular-nums">当前 v{entry.version}</span>
          </p>
        </div>
        <Link
          href={`/admin/content/${entry.kind}/${encodeURIComponent(entry.slug)}`}
          className="rounded-xl border border-border px-3.5 py-2 text-sm text-muted transition-colors hover:text-foreground"
        >
          返回编辑
        </Link>
      </header>

      <p className="mt-4 rounded-xl border border-border bg-surface px-4 py-3 text-xs leading-relaxed text-muted">
        每次保存、发布、恢复都会生成一版快照。恢复会**生成新版本**而不是覆盖历史，
        并且不会回滚发布状态与标签（这两项在审计里记为 <code className="font-mono">tagsPreserved</code>）。
      </p>

      {revisions.length === 0 ? (
        <p className="mt-4 rounded-xl border border-border bg-elevated px-4 py-8 text-center text-sm text-muted">
          还没有任何历史版本。
        </p>
      ) : (
        <ol className="mt-4 space-y-2">
          {revisions.map((revision) => (
            <RevisionItem
              key={revision.id}
              revision={revision}
              entryId={entry.id}
              expectedVersion={entry.version}
              isCurrent={revision.version === entry.version}
            />
          ))}
        </ol>
      )}
    </>
  );
}

function RevisionItem({
  revision,
  entryId,
  expectedVersion,
  isCurrent,
}: {
  revision: RevisionRow;
  entryId: string;
  expectedVersion: number;
  isCurrent: boolean;
}) {
  return (
    <li className="rounded-xl border border-border bg-elevated px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <span className="tabular-nums font-medium">v{revision.version}</span>
            {isCurrent ? (
              <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">
                当前
              </span>
            ) : null}
            <span className="truncate text-xs text-muted">
              {revision.changeNote ?? "(无变更说明)"}
            </span>
          </p>
          <p className="mt-1 text-[11px] tabular-nums text-muted-deep">
            {formatDate(revision.createdAt.toISOString())}
            {revision.createdBy ? ` · ${revision.createdBy.slice(0, 8)}` : " · 系统"}
          </p>
        </div>

        {isCurrent ? (
          <span className="text-[11px] text-muted-deep">已是最新</span>
        ) : (
          <RestoreRevisionButton
            entryId={entryId}
            targetVersion={revision.version}
            expectedVersion={expectedVersion}
          />
        )}
      </div>
    </li>
  );
}

/** `decodeURIComponent` 对非法转义会抛 `URIError`，兜住并回退原串。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function ListSkeleton() {
  return (
    <div className="mt-6 space-y-2" aria-busy="true">
      <div className="h-9 w-64 animate-pulse rounded-lg bg-surface" />
      <div className="h-20 animate-pulse rounded-xl border border-border bg-elevated" />
      <div className="h-20 animate-pulse rounded-xl border border-border bg-elevated" />
      <div className="h-20 animate-pulse rounded-xl border border-border bg-elevated" />
    </div>
  );
}
