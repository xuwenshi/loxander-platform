"use client";

import { useActionState, useState } from "react";

import {
  archiveEntryAction,
  publishEntryAction,
  scheduleEntryAction,
  unpublishEntryAction,
  type ActionResult,
} from "@/lib/admin/actions";
import { AdminStatusPill } from "@/components/admin/status-pill";
import { STATUS_LABELS, type AdminStatus } from "@/lib/admin/validation";

/**
 * 编辑页顶部的状态操作区（Client Component）。
 *
 * ── 为什么拆成四个独立 form 而不是一个带按钮名的 form ──────────────────
 * 四个动作的**语义完全不同**（发布要重校验正文、定时要多读一个时间、
 * 归档要确认、撤回草稿要清 published_at）。用一个 form + 不同
 * `<button name="intent">` 会让服务端必须先读 intent 再分支，等于把
 * 四个 action 又合并回一个 switch —— 而 `actions.ts` 里已经是四个
 * 独立导出的 Server Action，各自有独立的错误文案与审计动作名。
 *
 * ── 为什么每个 form 都塞 expectedVersion ────────────────────────────
 * 状态流转也要过乐观锁（方案 §8.4 第 5 道关）。页面渲染时读到的版本是 N，
 * 若另一个标签页已经把内容改到 N+1，这次发布必须失败并提示刷新，
 * 而不是拿旧内容去发布。
 *
 * ── 定时发布的时间为什么要在浏览器里转成带偏移的 ISO ────────────────
 * `<input type="datetime-local">` 提交的是 `2026-10-24T10:00`，**没有时区**。
 * 服务端 `new Date("2026-10-24T10:00")` 会按服务器时区解释（Vercel 是 UTC），
 * 结果比管理员想的早 8 小时。这里在提交前用浏览器时区把它转成
 * `2026-10-24T02:00:00.000Z` 这种带 Z 的绝对时刻，服务端只做格式校验。
 */
export interface EntryStatusBarProps {
  entryId: string;
  expectedVersion: string;
  status: string;
  /** 当前展示日期（blog/diary 的 display_date），用于提示首次发布会用它。 */
  displayDate: string | null;
}

const INITIAL: ActionResult | null = null;

export function EntryStatusBar({
  entryId,
  expectedVersion,
  status,
  displayDate,
}: EntryStatusBarProps) {
  const [publishState, publishAction, publishPending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => publishEntryAction(formData),
    INITIAL,
  );
  const [unpublishState, unpublishAction, unpublishPending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => unpublishEntryAction(formData),
    INITIAL,
  );
  const [archiveState, archiveAction, archivePending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => archiveEntryAction(formData),
    INITIAL,
  );
  const [scheduleState, scheduleAction, schedulePending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => scheduleEntryAction(formData),
    INITIAL,
  );

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const adminStatus = (["draft", "scheduled", "published", "archived"] as const).includes(
    status as AdminStatus,
  )
    ? (status as AdminStatus)
    : "draft";

  const messages = [publishState, unpublishState, archiveState, scheduleState];
  const anyPending = publishPending || unpublishPending || archivePending || schedulePending;

  const handleScheduleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    // 空值直接拦在这里：交给服务端只会得到一句「格式不正确」，
    // 不如在本地就说清楚「还没选时间」。
    if (!scheduleLocal) {
      event.preventDefault();
      setScheduleError("请先选择定时发布时间");
      return;
    }
    const parsed = new Date(scheduleLocal);
    if (Number.isNaN(parsed.getTime())) {
      event.preventDefault();
      setScheduleError("定时发布时间无法解析");
      return;
    }
    if (parsed.getTime() <= Date.now()) {
      event.preventDefault();
      setScheduleError("定时发布时间必须晚于当前时间");
      return;
    }
    setScheduleError(null);
  };

  return (
    <section
      aria-label="状态操作"
      className="mt-5 rounded-xl border border-border bg-elevated p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs text-muted">当前状态</span>
        <AdminStatusPill status={status} />
        <span className="text-xs tabular-nums text-muted">v{expectedVersion}</span>
        {displayDate ? (
          <span className="text-xs text-muted">展示日期 {displayDate}</span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {adminStatus !== "published" ? (
          <form action={publishAction}>
            <input type="hidden" name="entryId" value={entryId} />
            <input type="hidden" name="expectedVersion" value={expectedVersion} />
            <button
              type="submit"
              disabled={anyPending}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {publishPending ? "发布中…" : "发布"}
            </button>
          </form>
        ) : null}

        {adminStatus === "published" ? (
          <form action={unpublishAction}>
            <input type="hidden" name="entryId" value={entryId} />
            <input type="hidden" name="expectedVersion" value={expectedVersion} />
            <button
              type="submit"
              disabled={anyPending}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {unpublishPending ? "撤回中…" : "撤回为草稿"}
            </button>
          </form>
        ) : null}

        <button
          type="button"
          onClick={() => setScheduleOpen((value) => !value)}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
        >
          {scheduleOpen ? "取消定时" : "定时发布"}
        </button>

        {adminStatus !== "archived" ? (
          <form action={archiveAction}>
            <input type="hidden" name="entryId" value={entryId} />
            <input type="hidden" name="expectedVersion" value={expectedVersion} />
            <button
              type="submit"
              disabled={anyPending}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-warning hover:text-warning disabled:cursor-not-allowed disabled:opacity-50"
            >
              {archivePending ? "归档中…" : "归档"}
            </button>
          </form>
        ) : null}
      </div>

      {scheduleOpen ? (
        <form
          action={scheduleAction}
          onSubmit={handleScheduleSubmit}
          className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface p-3"
        >
          <input type="hidden" name="entryId" value={entryId} />
          <input type="hidden" name="expectedVersion" value={expectedVersion} />
          <label className="block">
            <span className="mb-1 block text-xs text-muted">定时发布时间（本机时区）</span>
            <input
              type="datetime-local"
              value={scheduleLocal}
              onChange={(event) => setScheduleLocal(event.target.value)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
            />
          </label>
          {/* 真正提交的值：带 Z 的绝对时刻，服务端不再猜时区。 */}
          <input
            type="hidden"
            name="scheduledAt"
            value={scheduleLocal ? new Date(scheduleLocal).toISOString() : ""}
          />
          <button
            type="submit"
            disabled={schedulePending}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {schedulePending ? "提交中…" : "确认定时"}
          </button>
          {scheduleError ? <p className="text-xs text-error">{scheduleError}</p> : null}
        </form>
      ) : null}

      <div className="mt-3 space-y-1">
        {messages.map((state, index) =>
          state?.formError ? (
            <p key={`err-${index}`} role="alert" className="text-xs text-error">
              {state.formError}
            </p>
          ) : null,
        )}
        {messages.map((state, index) =>
          state?.ok && state.message ? (
            <p key={`ok-${index}`} role="status" className="text-xs text-success">
              {state.message}
            </p>
          ) : null,
        )}
        {adminStatus === "scheduled" ? (
          <p className="text-xs text-muted">
            定时发布需要配合外部 cron 才会真正切换状态；在此之前内容仍是 scheduled，
            不会出现在公开站点上。
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** 状态文案兜底：`AdminStatusPill` 内部已有一份，这里只给「未发布」这类说明用。 */
export function statusLabelOf(status: string): string {
  return STATUS_LABELS[status as AdminStatus] ?? status;
}
