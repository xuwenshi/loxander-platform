"use client";

import Link from "next/link";
import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MarkdownEditor } from "@/components/admin/markdown-editor";
import {
  createEntryAction,
  saveEntryAction,
  type ActionResult,
} from "@/lib/admin/actions";
import { renderPreviewAction } from "@/lib/admin/preview-actions";
import { FORM_ENUMS } from "@/lib/admin/validation";
import type { EntryKind } from "@loxander/content-core";

/**
 * 内容编辑表单（Client Component）。
 *
 * ── 为什么整个表单是客户端组件 ────────────────────────────────────────
 * CodeMirror 必须在浏览器里跑，而正文 textarea 由它接管，所以表单里至少
 * 正文那一块是客户端的。既然已经客户端了，把其余字段也放进来，避免
 * 「Server 渲染外壳 + 客户端字段」这种一半一半带来的初值同步问题。
 *
 * ── 提交为什么用 `useActionState` 而不是 `<form action={fn}>` ─────────
 * `createEntryAction` / `saveEntryAction` 返回 `ActionResult`（字段错误、
 * 版本冲突都要原地回显）。React 的 `<form action={fn}>` 只接受返回 `void`
 * 的函数，返回值会被静默丢掉。`useActionState` 能拿到它。
 *
 * ── 预览为什么是「手动点」+ 防抖自动跑 ─────────────────────────────────
 * 预览要走服务端（Shiki 高亮器在浏览器里加载太贵，且必须与线上渲染一致），
 * 每敲一个字符发一次请求会打爆网络。所以：停手 700ms 后自动跑一次，
 * 同时保留「刷新预览」按钮给等不及的人。
 */

const PREVIEW_DEBOUNCE_MS = 700;

export interface EntryEditorValues {
  kind: EntryKind;
  slug: string;
  title: string;
  summary: string;
  bodyMd: string;
  tags: string;
  /** `YYYY-MM-DD`；projects/goals 为空串。 */
  displayDate: string;
  category: string;
  cover: string;
  mood: string;
  techStack: string;
  projectStatus: string;
  period: string;
  role: string;
  github: string;
  demo: string;
  article: string;
  featured: boolean;
  sortOrder: string;
  horizon: string;
  goalStatus: string;
  progress: string;
  milestones: { title: string; done: boolean }[];
}

export interface EntryEditorProps {
  mode: "create" | "edit";
  /** 编辑模式下的 entry id；新建时为空串。 */
  entryId: string;
  /** 编辑模式下页面渲染时读到的版本（乐观锁）。新建时为 "1"。 */
  expectedVersion: string;
  values: EntryEditorValues;
  /** 当前发布状态，仅用于提示文案。 */
  publishStatus: string;
}

const INITIAL_STATE: ActionResult | null = null;

export function EntryEditor({
  mode,
  entryId,
  expectedVersion,
  values,
  publishStatus,
}: EntryEditorProps) {
  const kind = values.kind;

  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) =>
      mode === "create" ? createEntryAction(formData) : saveEntryAction(formData),
    INITIAL_STATE,
  );

  const [bodyMd, setBodyMd] = useState(values.bodyMd);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // 里程碑在客户端要有「增删行」的能力，所以放在 state 里。
  const [milestones, setMilestones] = useState(values.milestones);

  const runPreview = useCallback(
    async (markdown: string) => {
      setPreviewPending(true);
      try {
        const result = await renderPreviewAction(markdown, kind);
        if (result.ok && result.html) {
          setPreviewHtml(result.html);
          setPreviewError(null);
        } else {
          setPreviewError(result.error ?? "预览失败");
        }
      } catch (error) {
        setPreviewError(error instanceof Error ? error.message : String(error));
      } finally {
        setPreviewPending(false);
      }
    },
    [kind],
  );

  // 防抖自动预览：只在展开预览面板时才跑，收起时不浪费请求。
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!showPreview) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void runPreview(bodyMd);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [bodyMd, showPreview, runPreview]);

  const fieldErrors = state?.fieldErrors ?? {};
  const formError = state?.formError;

  const kindLabel = useMemo(
    () =>
      ({ blog: "文章", diary: "日记", projects: "项目", goals: "目标" } as Record<string, string>)[
        kind
      ] ?? kind,
    [kind],
  );

  return (
    <form action={formAction} className="mt-6 space-y-5">
      {/* 隐藏字段：kind / entryId / expectedVersion 是服务端定位与乐观锁的依据。 */}
      <input type="hidden" name="kind" value={kind} />
      {mode === "edit" ? <input type="hidden" name="entryId" value={entryId} /> : null}
      <input type="hidden" name="expectedVersion" value={expectedVersion} />

      {formError ? (
        <p role="alert" className="rounded-xl border border-error/40 bg-error/10 px-4 py-3 text-sm text-error">
          {formError}
          {state?.currentVersion ? (
            <span className="ml-1 text-xs">
              （服务端当前版本 v{state.currentVersion}，请刷新页面后重试）
            </span>
          ) : null}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── 左列：正文 + 预览 ─────────────────────────────────────── */}
        <div className="min-w-0 space-y-4">
          <Field label="标题" htmlFor="title" error={fieldErrors.title}>
            <input
              id="title"
              name="title"
              defaultValue={values.title}
              className={inputClass}
              placeholder={kind === "projects" ? "项目名称" : "标题"}
            />
          </Field>

          <Field
            label={kind === "goals" ? "备注（goals 无摘要字段，可留空）" : "摘要"}
            htmlFor="summary"
            error={fieldErrors.summary}
            hint={kind === "goals" ? "目标类型在数据库里没有摘要列，这里填了也不会保存。" : undefined}
          >
            <textarea
              id="summary"
              name="summary"
              defaultValue={values.summary}
              rows={2}
              disabled={kind === "goals"}
              className={inputClass}
            />
          </Field>

          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="bodyMd" className="text-sm font-medium text-foreground">
                正文（Markdown）
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowPreview((value) => !value)}
                  className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:text-foreground"
                >
                  {showPreview ? "隐藏预览" : "显示预览"}
                </button>
                {showPreview ? (
                  <button
                    type="button"
                    onClick={() => void runPreview(bodyMd)}
                    disabled={previewPending}
                    className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-50"
                  >
                    {previewPending ? "渲染中…" : "刷新预览"}
                  </button>
                ) : null}
              </div>
            </div>

            {/* 真正的提交值：CodeMirror 不写进 form，靠这个隐藏域同步。 */}
            <input type="hidden" name="bodyMd" value={bodyMd} />
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              <MarkdownEditor value={bodyMd} onChange={setBodyMd} id="bodyMd" />
            </div>
            {fieldErrors.bodyMd ? (
              <p className="mt-1 text-xs text-error">{fieldErrors.bodyMd}</p>
            ) : null}
          </div>

          {showPreview ? (
            <section
              aria-label="预览"
              className="rounded-xl border border-border bg-elevated p-4"
            >
              <p className="mb-2 text-xs text-muted">
                预览经过 rehype-sanitize 与 DOMPurify 两道净化，与发布后的渲染管线一致。
              </p>
              {previewError ? (
                <p className="text-sm text-error">{previewError}</p>
              ) : previewHtml ? (
                <div
                  className="prose prose-slate max-w-none dark:prose-invert"
                  // 内容已经过两道净化（见 lib/admin/preview.ts）。
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : (
                <p className="text-sm text-muted">
                  {previewPending ? "正在渲染…" : "暂无预览，点「刷新预览」生成。"}
                </p>
              )}
            </section>
          ) : null}
        </div>

        {/* ── 右列：元数据 ──────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-border bg-elevated p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
              {kindLabel}字段
            </h2>
            <div className="mt-3 space-y-3">
              <Field label="slug" htmlFor="slug" error={fieldErrors.slug} hint="只能字母数字点下划线连字符">
                <input
                  id="slug"
                  name="slug"
                  defaultValue={values.slug}
                  className={`${inputClass} font-mono`}
                />
              </Field>

              {(kind === "blog" || kind === "diary") && (
                <Field label="展示日期" htmlFor="displayDate" error={fieldErrors.displayDate}>
                  <input
                    id="displayDate"
                    name="displayDate"
                    type="date"
                    defaultValue={values.displayDate}
                    className={inputClass}
                  />
                </Field>
              )}

              {kind === "blog" && (
                <>
                  <Field label="分类" htmlFor="category" error={fieldErrors.category}>
                    <input
                      id="category"
                      name="category"
                      defaultValue={values.category}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="封面路径" htmlFor="cover" error={fieldErrors.cover}>
                    <input
                      id="cover"
                      name="cover"
                      defaultValue={values.cover}
                      placeholder="/images/xxx.svg"
                      className={inputClass}
                    />
                  </Field>
                </>
              )}

              {kind === "diary" && (
                <Field label="心情" htmlFor="mood" error={fieldErrors.mood}>
                  <input id="mood" name="mood" defaultValue={values.mood} className={inputClass} />
                </Field>
              )}

              {kind === "projects" && (
                <>
                  <Field label="技术栈" htmlFor="techStack" error={fieldErrors.techStack} hint="逗号或换行分隔">
                    <input
                      id="techStack"
                      name="techStack"
                      defaultValue={values.techStack}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="状态" htmlFor="projectStatus" error={fieldErrors.status}>
                    <select
                      id="projectStatus"
                      name="status"
                      defaultValue={values.projectStatus || "in-progress"}
                      className={inputClass}
                    >
                      {FORM_ENUMS.projectStatuses.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="周期" htmlFor="period" error={fieldErrors.period}>
                    <input id="period" name="period" defaultValue={values.period} className={inputClass} />
                  </Field>
                  <Field label="角色" htmlFor="role" error={fieldErrors.role}>
                    <input id="role" name="role" defaultValue={values.role} className={inputClass} />
                  </Field>
                  <Field label="仓库地址" htmlFor="github" error={fieldErrors.github}>
                    <input id="github" name="github" defaultValue={values.github} className={inputClass} />
                  </Field>
                  <Field label="演示地址" htmlFor="demo" error={fieldErrors.demo}>
                    <input id="demo" name="demo" defaultValue={values.demo} className={inputClass} />
                  </Field>
                  <Field label="关联文章 slug" htmlFor="article" error={fieldErrors.article}>
                    <input id="article" name="article" defaultValue={values.article} className={inputClass} />
                  </Field>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      name="featured"
                      defaultChecked={values.featured}
                      className="h-3.5 w-3.5 accent-[var(--accent)]"
                    />
                    精选
                  </label>
                </>
              )}

              {kind === "goals" && (
                <>
                  <Field label="时间跨度" htmlFor="horizon" error={fieldErrors.horizon}>
                    <select
                      id="horizon"
                      name="horizon"
                      defaultValue={values.horizon || "short"}
                      className={inputClass}
                    >
                      {FORM_ENUMS.goalHorizons.map((horizon) => (
                        <option key={horizon} value={horizon}>
                          {horizon}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="状态" htmlFor="goalStatus" error={fieldErrors.status}>
                    <select
                      id="goalStatus"
                      name="status"
                      defaultValue={values.goalStatus || "planned"}
                      className={inputClass}
                    >
                      {FORM_ENUMS.goalStatuses.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="进度 %" htmlFor="progress" error={fieldErrors.progress}>
                    <input
                      id="progress"
                      name="progress"
                      type="number"
                      min={0}
                      max={100}
                      defaultValue={values.progress}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="周期" htmlFor="period" error={fieldErrors.period}>
                    <input id="period" name="period" defaultValue={values.period} className={inputClass} />
                  </Field>
                </>
              )}

              {(kind === "projects" || kind === "goals") && (
                <Field label="排序值" htmlFor="sortOrder" error={fieldErrors.sortOrder} hint="小的在前，默认 999">
                  <input
                    id="sortOrder"
                    name="sortOrder"
                    type="number"
                    defaultValue={values.sortOrder}
                    className={inputClass}
                  />
                </Field>
              )}

              <Field label="标签" htmlFor="tags" error={fieldErrors.tags} hint="逗号或换行分隔，顺序即展示顺序">
                <textarea
                  id="tags"
                  name="tags"
                  defaultValue={values.tags}
                  rows={2}
                  className={inputClass}
                />
              </Field>
            </div>
          </div>

          {kind === "goals" ? (
            <div className="rounded-xl border border-border bg-elevated p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">里程碑</h2>
              <div className="mt-3 space-y-2">
                {milestones.map((milestone, index) => (
                  <div key={index} className="flex items-center gap-2">
                    {/* aria-label 必须带序号：一屏可能有 N 条里程碑，读屏听到的
                        名字若全同就无法区分（placeholder 不算标签，输入后即消失）。 */}
                    <input
                      name="milestoneTitle"
                      defaultValue={milestone.title}
                      placeholder="里程碑标题"
                      aria-label={`里程碑 ${index + 1} 标题`}
                      className={`${inputClass} min-w-0 flex-1`}
                    />
                    <input
                      type="checkbox"
                      name="milestoneDone"
                      defaultChecked={milestone.done}
                      aria-label={`里程碑 ${index + 1} 已完成`}
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                    />
                    <button
                      type="button"
                      onClick={() => setMilestones((rows) => rows.filter((_, i) => i !== index))}
                      className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-muted hover:text-error"
                    >
                      删除
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setMilestones((rows) => [...rows, { title: "", done: false }])}
                  className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground"
                >
                  + 添加里程碑
                </button>
              </div>
            </div>
          ) : null}

          <div className="rounded-xl border border-border bg-elevated p-4">
            <Field label="变更说明" htmlFor="changeNote" error={fieldErrors.changeNote} hint="可选，写进版本历史">
              <input
                id="changeNote"
                name="changeNote"
                maxLength={200}
                placeholder="这次改了什么"
                className={inputClass}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-[var(--on-accent)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "保存中…" : mode === "create" ? "创建草稿" : "保存"}
            </button>
            <Link
              href="/admin/content"
              className="rounded-xl border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground"
            >
              返回列表
            </Link>
          </div>

          {state?.ok && state.message ? (
            <p role="status" className="text-xs text-success">
              {state.message}
            </p>
          ) : null}

          {mode === "edit" ? (
            <p className="text-xs text-muted">
              当前状态：{publishStatus} · 版本 v{expectedVersion}
              。发布/归档等状态操作在页面上方的操作区。
            </p>
          ) : (
            <p className="text-xs text-muted">
              新建内容一律先落成草稿；创建完成后到编辑页再执行发布。
            </p>
          )}
        </aside>
      </div>
    </form>
  );
}

const inputClass =
  "w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground placeholder:text-muted-deep focus:border-accent focus:outline-none";

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="mt-1 text-[11px] text-muted-deep">{hint}</p> : null}
      {error ? <p className="mt-1 text-[11px] text-error">{error}</p> : null}
    </div>
  );
}
