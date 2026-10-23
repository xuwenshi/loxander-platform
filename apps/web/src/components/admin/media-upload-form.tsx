"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

import { uploadMediaAction, type MediaActionResult } from "@/lib/admin/media-actions";

/**
 * 上传表单（Client Component）。
 *
 * ── 为什么 form 的 action 是 `useActionState` 包装后的函数，而不是直接
 *    把 `uploadMediaAction` 传给 `<form action>` ────────────────────────
 * `uploadMediaAction` 返回 `MediaActionResult`（要显示「文件是空的」还是
 * 「只支持 PNG、JPEG……」还是「图片已存但登记失败」）。React 的
 * `<form action={fn}>` 只接受返回 `void` 的函数，直接把返回值的 action 传进去
 * 会**静默丢掉返回值** —— 用户选了个 PDF，点上传，页面什么都不发生，也没有
 * 任何解释。P4 的 `bulk-archive-form.tsx:17-21` 已经踩过这个坑并写下了同样的
 * 结论，这里照同一套来。
 *
 * ── 为什么 pending 态用 `useFormStatus` 而不是 `useActionState` 的第三项 ──
 * 两者都拿得到 pending，但用途不同：`useActionState` 的 pending 在**提交之后
 * 一直保持 true 直到整次 revalidate 完成**，按钮会长时间停在「上传中…」；
 * `useFormStatus` 描述的才是「这个 form 正在提交」。用 `useFormStatus` 更贴近
 * 用户看到的事实，而且它必须在 form 的**子组件**里调用（在 form 同一层调用
 * 永远返回 false），所以拆出了下面的 `SubmitButton`。
 *
 * ── 为什么不用 `onChange` 手动 fetch ────────────────────────────────
 * 那样要自己处理：读文件、拼 FormData、发请求、解析响应、设置 pending、
 * 刷新页面数据。而 `<form action={serverAction}>` 这一条路径上，浏览器负责
 * 编码 multipart、React 负责 pending、Server Action 结束时 `revalidatePath`
 * 负责刷新。手动 fetch 唯一的好处是能显示上传进度百分比，而这里没有这个需求
 * （单张 ≤10 MB，局域网/现代带宽下是秒级）。
 */

const INITIAL: MediaActionResult | null = null;

export function MediaUploadForm() {
  const [state, formAction] = useActionState(
    async (_previous: MediaActionResult | null, formData: FormData) => uploadMediaAction(formData),
    INITIAL,
  );

  const formRef = useRef<HTMLFormElement>(null);

  /*
    上传成功后清空表单。

    必要的原因很具体：`<input type="file" name="file">` 的选中值是**非受控**的，
    服务端返回成功后它仍然停在上一个文件上。用户看到缩略图没变、文件名还在，
    很容易再点一次「上传」，于是同一张图被传了两遍（pathname 里的时间戳不同，
    数据库里就是两行，唯一索引拦不住）。

    依赖 `state` 而不是 `state.ok`：同一张图连续上传两次都会返回 ok，若只用
    `state.ok` 做依赖，第二次的成功不会触发 effect（值没变）。`useActionState`
    每次提交都返回**新对象**，所以引用变化一定触发。
  */
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="mt-6 rounded-xl border border-border bg-elevated p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">图片文件</span>
          <input
            type="file"
            name="file"
            required
            // 与服务端 `sniffImage` 的白名单一致。这**只是**给文件选择器的提示，
            // 不是校验 —— 用户可以选「所有文件」，也可以改扩展名。真正的判定
            // 在服务端按魔数做。
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-surface file:px-2 file:py-1 file:text-xs file:text-muted"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">替代文本（alt）</span>
          <input
            type="text"
            name="alt"
            maxLength={300}
            placeholder="描述这张图的内容，供读屏与图片加载失败时使用"
            className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-relaxed text-muted">
          支持 PNG、JPEG、GIF、WebP、SVG，单张不超过 10 MB。文件类型按字节头判定，不认扩展名。
        </p>
        <SubmitButton />
      </div>

      {state?.fieldErrors?.file ? (
        <p role="alert" className="mt-2 text-xs text-error">
          {state.fieldErrors.file}
        </p>
      ) : null}
      {state?.formError ? (
        <p role="alert" className="mt-2 text-xs text-error">
          {state.formError}
        </p>
      ) : null}
      {state?.ok && state.message ? (
        <p role="status" className="mt-2 text-xs text-success">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * 提交按钮。**必须**是独立组件：`useFormStatus` 读的是「最近的上级 form」的
 * 提交状态，与 form 写在同一个组件里时读到的永远是 false（React 文档明确说明）。
 */
function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="shrink-0 rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-[var(--on-accent)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? "上传中…" : "上传"}
    </button>
  );
}
