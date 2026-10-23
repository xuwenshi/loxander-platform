"use client";

import { useActionState } from "react";

import { restoreRevisionAction, type ActionResult } from "@/lib/admin/actions";

/**
 * 恢复某个历史版本（Client Component）。
 *
 * ── 为什么需要二次确认 ───────────────────────────────────────────────
 * 恢复会生成**新的一版**（内容等于旧版本），当前内容不会丢，但列表页
 * 与公开站点会立刻变成旧内容。一次误点足够让人以为「内容被回退了」，
 * 所以这里用 `window.confirm` 加一道确认 —— 它不是安全机制，只是防手滑。
 *
 * ── 为什么传 expectedVersion ────────────────────────────────────────
 * 恢复也走乐观锁（`restoreRevisionAction` 会比对 `current.version`）。
 * 页面上渲染的是 vN，若别人已经改到 vN+1，恢复必须失败并要求刷新，
 * 否则会用旧快照盖掉别人刚做的修改。
 */
export interface RestoreRevisionButtonProps {
  entryId: string;
  targetVersion: number;
  expectedVersion: number;
}

const INITIAL: ActionResult | null = null;

export function RestoreRevisionButton({
  entryId,
  targetVersion,
  expectedVersion,
}: RestoreRevisionButtonProps) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) =>
      restoreRevisionAction(formData),
    INITIAL,
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        const ok = window.confirm(
          `恢复到 v${targetVersion}？\n\n当前内容会作为新版本保留，历史链条不会丢。`,
        );
        if (!ok) event.preventDefault();
      }}
      className="inline-flex flex-col items-end gap-1"
    >
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="version" value={targetVersion} />
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "恢复中…" : "恢复此版本"}
      </button>
      {state?.formError ? (
        <span role="alert" className="text-[11px] text-error">
          {state.formError}
        </span>
      ) : null}
      {state?.ok && state.message ? (
        <span role="status" className="text-[11px] text-success">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
