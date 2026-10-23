"use client";

import { useActionState } from "react";

import { bulkArchiveAction, type ActionResult } from "@/lib/admin/actions";

/**
 * 批量归档的提交栏（Client Component）。
 *
 * ── 为什么 form 与表格分离 ─────────────────────────────────────────
 * 表格是 Server 渲染的（`page.tsx`），里面的 `<input type="checkbox" name="entryId">`
 * 通过 HTML 的 `form="bulk-archive-form"` 属性关联到这个 form。form 属性按 id 关联，
 * 与 DOM 顺序无关，所以 form 写在表格之后也能把勾选值一起提交。
 * 好处：整张大表不用变成客户端组件，只有这颗按钮所在的 form 是。
 *
 * ── 为什么用 useActionState 而不是直接把 action 传给 form ──────────
 * `bulkArchiveAction` 返回 `ActionResult`（要显示「已归档 N 条」或错误原因）。
 * React 的 `<form action={fn}>` 只接受返回 `void` 的函数，直接传会静默丢掉返回值。
 * `useActionState` 能拿到返回值并渲染提示。
 */
export const BULK_ARCHIVE_FORM_ID = "bulk-archive-form";

const INITIAL: ActionResult | null = null;

export function BulkArchiveBar() {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => bulkArchiveAction(formData),
    INITIAL,
  );

  return (
    <form
      id={BULK_ARCHIVE_FORM_ID}
      action={formAction}
      className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2.5"
    >
      <div className="min-w-0">
        <p className="text-xs leading-relaxed text-muted">
          勾选表格左侧复选框后提交。归档不删除内容，历史版本与审计都保留；已归档的会被跳过。
        </p>
        {state?.formError ? (
          <p role="alert" className="mt-1 text-xs text-error">
            {state.formError}
          </p>
        ) : null}
        {state?.ok && state.message ? (
          <p role="status" className="mt-1 text-xs text-success">
            {state.message}
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-warning hover:text-warning disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "归档中…" : "归档所选"}
      </button>
    </form>
  );
}
