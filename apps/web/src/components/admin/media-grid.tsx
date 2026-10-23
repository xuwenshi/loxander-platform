"use client";

import { useActionState } from "react";

import { deleteMediaAction, type MediaActionResult } from "@/lib/admin/media-actions";
import type { MediaRow } from "@/lib/admin/media";

/**
 * 媒体网格（Client Component）。
 *
 * ── 为什么是 Client Component，而任务说明推荐 Server ──────────────────
 * 因为删除按钮**必须能显示服务端的拒绝原因**。「该图被 3 处引用，先解除引用再删」
 * 这句提示是引用检查这道关的唯一出口：如果 `<form action={deleteMediaAction}>`
 * 直接把 Server Action 传给 form，React 会当作「返回 void」处理，返回值里的
 * `formError` 被静默丢弃 —— 用户点了删除，页面什么都不变，也没有任何解释。
 * 要拿到返回值必须用 `useActionState`，而它是客户端 hook。代价是这张网格变成
 * 客户端组件（多几 KB 的 hydrate），换来的是删除失败可解释。
 *
 * ── 为什么每行一个独立 form、各自一套 useActionState ─────────────────
 * 删除是**按行**的动作，错误也应该显示在那一行上（而不是页面顶部一个全局提示，
 * 用户还得自己找是哪张图）。所以拆成一个 `MediaCard` 子组件，每张图自己持有
 * 状态。这也避免了「同一次提交影响所有行」的串扰。
 *
 * ── 为什么用 <img> 而不是 next/image ────────────────────────────────
 * `next/image` 对外部域名的图片要求在 `next.config.ts` 里声明
 * `images.remotePatterns`。Blob 的域名是部署时才确定的
 * （`<store-id>.public.blob.vercel-storage.com`），本仓库的 `next.config.ts`
 * **没有**这一项；本地兜底模式下 URL 是 `/media/...` 同源路径，本来也不需要
 * 优化。改用 `<img>` 的代价是失去自动尺寸优化与懒加载占位 —— 媒体库是后台
 * 页面，几十张图、每个管理员看几秒，这个代价可以接受。真要优化，先把
 * remotePatterns 配上、再换回 next/image，那时才有收益。
 */

/** 网格行：媒体行 + 引用数。引用数由页面算好传进来（页面已经查过一遍）。 */
export interface MediaGridRow extends MediaRow {
  referenceCount: number;
}

const INITIAL: MediaActionResult | null = null;

/** 人类可读的文件大小。后台只用来快速判断「这张图是不是太大」，不需要精确到字节。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 尺寸展示。SVG 嗅探不出宽高，`null` 时显示「—」而不是「0×0」。 */
function formatDimensions(width: number | null, height: number | null): string {
  if (width === null || height === null) return "—";
  return `${width} × ${height}`;
}

export function MediaGrid({ rows }: { rows: MediaGridRow[] }) {
  return (
    <div className="mt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-foreground">全部图片</h2>
        <span className="text-xs tabular-nums text-muted">共 {rows.length} 张</span>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <MediaCard key={row.id} row={row} />
        ))}
      </ul>
    </div>
  );
}

function MediaCard({ row }: { row: MediaGridRow }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: MediaActionResult | null, formData: FormData) => deleteMediaAction(formData),
    INITIAL,
  );

  // 被引用过的图不允许删 —— 服务端也会再查一次并拒绝。这里禁用按钮只是
  // 提前把「为什么不能删」摆出来，**不是**安全边界（服务端的检查才是）。
  const referenced = row.referenceCount > 0;

  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
      {/*
        缩略图容器固定高度 + `object-cover`：不同宽高比的图（横图、竖图、SVG）
        在网格里保持同一行高，否则一行卡片会参差不齐。
      */}
      <div className="h-40 w-full overflow-hidden bg-elevated">
        {/* eslint-disable-next-line @next/next/no-img-element -- 理由见文件头注释 */}
        <img
          src={row.url}
          alt={row.alt}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="truncate font-mono text-xs text-foreground" title={row.path}>
          {row.path}
        </p>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted">
          <dt>尺寸</dt>
          <dd className="tabular-nums">{formatDimensions(row.width, row.height)}</dd>
          <dt>大小</dt>
          <dd className="tabular-nums">{formatBytes(row.sizeBytes)}</dd>
          <dt>引用</dt>
          <dd className={referenced ? "text-accent" : "text-muted"}>
            {referenced ? `${row.referenceCount} 处` : "未被引用"}
          </dd>
        </dl>

        {row.alt ? (
          <p className="line-clamp-2 text-xs text-muted-deep">alt：{row.alt}</p>
        ) : (
          <p className="text-xs text-muted-deep">alt：未填写</p>
        )}

        <form action={formAction} className="mt-auto">
          <input type="hidden" name="id" value={row.id} />
          <button
            type="submit"
            disabled={pending || referenced}
            title={referenced ? "该图仍被引用，先解除引用再删" : undefined}
            className="w-full rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-error hover:text-error disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "删除中…" : "删除"}
          </button>
        </form>

        {state?.formError ? (
          <p role="alert" className="text-xs leading-relaxed text-error">
            {state.formError}
          </p>
        ) : null}
        {state?.ok && state.message ? (
          <p role="status" className="text-xs leading-relaxed text-success">
            {state.message}
          </p>
        ) : null}
      </div>
    </li>
  );
}
