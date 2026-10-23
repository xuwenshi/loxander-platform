"use server";

import { and, eq, inArray } from "drizzle-orm";
import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { renderMarkdown } from "@loxander/markdown";
import type { EntryKind } from "@loxander/content-core";

import {
  auditLogs,
  entries,
  entryRevisions,
  entryTags,
  tags as tagsTable,
} from "../../../../../db/schema";
import { tagSlugOf } from "../../../../../db/mapping";
import { requireAdmin } from "../auth";
import {
  ALL_ENTRIES_TAG,
  entriesTag,
  entryTag,
  TAGS_INDEX_TAG,
} from "../cache-tags";
import { getAdminDb } from "./db";
import {
  validateEntryForm,
  type FieldErrors,
} from "./validation";

/**
 * 后台**写**路径（Server Actions）。
 *
 * ── 方案 §8.4「后台写操作七道关」在这里逐条落地 ──────────────────────
 * 1. 登录态校验        → `requireAdmin()` 内部 `auth()`，无会话直接抛。
 * 2. 管理员白名单校验  → `requireAdmin()` 每次重查 `ADMIN_GITHUB_LOGIN`。
 * 3. Zod 参数校验      → `validateEntryForm()`（复用 content-core 的 schema）。
 * 4. 字段权限校验      → 只有该 kind 认识的字段会进入 frontmatter 拼装。
 * 5. 乐观锁版本比对    → `where version = expectedVersion`，冲突时 0 行受影响。
 * 6. 事务内写入与审计  → `db.transaction` 里同时写 entries / revisions / audit_logs。
 * 7. 缓存标签失效      → 事务提交**之后**才 `updateTag`（事务内失效会缓存脏数据）。
 *
 * ── 为什么每个 action 都要自己再校验一次 ─────────────────────────────
 * Next 16 的 proxy 文档明确警告（`proxy.md:249-251`）：Server Function 不是
 * 独立路由，proxy 的 matcher 排除掉的路径上 proxy 不会拦 Server Action。
 * 所以「proxy 里守一道」在这里等于没有防线。
 *
 * ── 为什么用 `updateTag` 而不是 `revalidateTag(tag, "max")` ──────────
 * 后台是「编辑完立刻回列表看结果」的场景。`revalidateTag(tag, "max")` 的语义是
 * **先返回陈旧内容、后台再刷新**（see `revalidateTag.md`），编辑者会看到自己
 * 刚改的内容没变。`updateTag` 是 read-your-own-writes 语义：立即过期，
 * 下一次请求等新数据。这正是后台需要的。
 * 局限性：`updateTag` 只能在 Server Action 里调用（`updateTag.md`）——
 * 本文件全是 Server Action，满足约束。
 */

/* -------------------------------------------------------------------------- */
/* 返回类型                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 所有 action 的统一返回。
 *
 * 刻意**不抛错给客户端**（除未登录/非管理员的鉴权错误）：抛出会让 Next 渲染
 * 错误页，编辑者填了半天的正文就丢了。返回结构化错误让表单原地回显。
 *
 * 用 `redirect()` 表示「成功并离开」时不会返回对象 —— `redirect` 靠抛异常实现，
 * 类型上写作 `Promise<ActionResult>` 但那条路径不会 resolve。
 */
export interface ActionResult {
  ok: boolean;
  /** 字段级错误，用于表单原地回显。 */
  fieldErrors?: FieldErrors;
  /** 整体错误（非字段相关，比如版本冲突、库错误）。 */
  formError?: string;
  /** 成功时的提示文案。 */
  message?: string;
  /** 乐观锁冲突时回传当前版本，便于页面提示「请刷新」。 */
  currentVersion?: number;
}

/* -------------------------------------------------------------------------- */
/* 内部工具                                                                    */
/* -------------------------------------------------------------------------- */

/** 三类内容读取时用的标题偏移（与 `db/mapping.ts:renderOptionsForKind` 同源）。 */
function headingOffsetOf(kind: EntryKind): number {
  return kind === "goals" ? 2 : 0;
}

/**
 * blog/diary 的 `published_at`：frontmatter 日期在东八区的零点。
 *
 * 与 `db/mapping.ts:east8Midnight` 口径一致 —— 若这里换成本地时区，
 * 后台改一次标题就会让这篇文章在列表里「日期变了」，与导入的数据对不上。
 */
function east8Midnight(displayDate: string): Date {
  return new Date(`${displayDate}T00:00:00+08:00`);
}

/**
 * 判断唯一键冲突（slug 重复）。
 *
 * **必须顺着 `cause` 链找**：drizzle 0.45 把驱动错误包成 `DrizzleQueryError`，
 * 它自己的 `code` 是 undefined，真正的 pg 错误码（`23505`）挂在 `error.cause.code` 上。
 * 只看顶层会让「slug 重复」退化成一条通用 `formError`，用户看不到是哪个字段冲突。
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const node = current as { code?: string; message?: string; cause?: unknown };
    if (node.code === "23505") return true;
    if (/duplicate key value/i.test(String(node.message ?? ""))) return true;
    current = node.cause;
  }
  return false;
}

/** 把未知异常收敛成一句人话，避免把堆栈泄漏到页面。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    // 数据库连接类错误给一句更有用的提示。
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect/i.test(error.message)) {
      return "数据库连接失败，请检查 DATABASE_URL 或网络后重试。";
    }
    return error.message;
  }
  return String(error);
}

/**
 * 重算缓存标签。
 *
 * 内容变更会影响三类页面：详情页、本分区列表、跨分区聚合（首页/星图/RSS/sitemap）。
 * `revalidatePath` 只处理当前访问过的路径缓存，标签才是根治手段。
 */
function invalidate(kind: EntryKind, slug: string, previousSlug?: string): void {
  updateTag(entryTag(kind, slug));
  updateTag(entriesTag(kind));
  updateTag(ALL_ENTRIES_TAG);

  // 改过 slug：旧地址的详情页缓存也得失效，否则旧 URL 还在吐旧内容。
  if (previousSlug && previousSlug !== slug) {
    updateTag(entryTag(kind, previousSlug));
  }

  /*
    P5：标签页的聚合缓存（有哪些标签、每个标签几篇）派生自文章列表，
    任何文章变更都可能改变它 —— 只改 blog 分区时才需要，
    因为标签只挂在 blog / diary 上，而标签页只展示 blog 的标签。
    这里不细分，统一失效：一次 `updateTag` 的成本远低于漏失效的代价。
  */
  updateTag(TAGS_INDEX_TAG);

  revalidatePath("/admin", "layout");
}

/**
 * 把一个版本的完整内容拍成快照（写进 `entry_revisions.snapshot`）。
 *
 * 快照必须是**完整可还原**的：恢复历史时只靠这份 JSON 就能重建整行，
 * 不需要再读任何别的地方。所以这里存的是 entries 的可写列全集，
 * 而不是「与上一版的差异」。
 */
function snapshotOf(row: {
  kind: string;
  slug: string;
  title: string;
  summary: string;
  body_md: string;
  body_html: string | null;
  publish_status: string;
  featured: boolean;
  sort_order: number;
  published_at: Date | null;
  display_date: string | null;
  data: unknown;
  version: number;
}): Record<string, unknown> {
  return {
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body_md: row.body_md,
    body_html: row.body_html,
    publish_status: row.publish_status,
    featured: row.featured,
    sort_order: row.sort_order,
    published_at: row.published_at ? row.published_at.toISOString() : null,
    display_date: row.display_date,
    data: row.data,
    version: row.version,
  };
}

/**
 * 重写一条内容的标签关系（先删后插）。
 *
 * 与 `db/import.ts:writeTagRelations` 同一套口径，但这里是**单条**：
 * 后台一次只改一条内容，按 entry_id 删干净再插，天然处理「删掉某个标签」
 * 这种 `onConflictDoUpdate` 处理不了的情况。
 */
async function rewriteTags(
  tx: Parameters<Parameters<Awaited<ReturnType<typeof getAdminDb>>["transaction"]>[0]>[0],
  entryId: string,
  names: readonly string[],
): Promise<void> {
  await tx.delete(entryTags).where(eq(entryTags.entry_id, entryId));
  if (names.length === 0) return;

  const rows = names.map((name) => ({ slug: tagSlugOf(name), name }));
  await tx
    .insert(tagsTable)
    .values(rows)
    .onConflictDoNothing({ target: tagsTable.slug });

  const existing = await tx
    .select({ id: tagsTable.id, slug: tagsTable.slug })
    .from(tagsTable)
    .where(inArray(tagsTable.slug, rows.map((row) => row.slug)));

  const idOfSlug = new Map(existing.map((row) => [row.slug, row.id]));

  const links = names
    .map((name, order) => {
      const tagId = idOfSlug.get(tagSlugOf(name));
      return tagId === undefined
        ? null
        : { entry_id: entryId, tag_id: tagId, tag_order: order };
    })
    .filter((link): link is NonNullable<typeof link> => link !== null);

  if (links.length > 0) {
    await tx.insert(entryTags).values(links);
  }
}

/* -------------------------------------------------------------------------- */
/* 新建                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 新建一条内容。
 *
 * 新建永远落成**草稿**（即使表单里勾了「发布」）：方案 §9.5 的发布是一条
 * 独立流程（校验 → 预览 → 确认 → 快照），新建时直接 published 会绕过它。
 * 调用方在创建成功后应当再调一次 `publishEntryAction`。
 */
export async function createEntryAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();

  const validation = validateEntryForm(formData);
  if (!validation.ok) {
    return { ok: false, fieldErrors: validation.fieldErrors, formError: "表单校验未通过" };
  }

  const { base, data, title, summary, featured, sortOrder, displayDate, tags } = validation;
  const kind = base.kind as EntryKind;

  const bodyHtml = await renderMarkdown(base.bodyMd, { headingOffset: headingOffsetOf(kind) });
  const db = await getAdminDb();

  let entryId: string;
  try {
    entryId = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(entries)
        .values({
          kind,
          slug: base.slug,
          title,
          summary,
          body_md: base.bodyMd,
          body_html: bodyHtml,
          // 新建一律草稿，见函数头注释。
          publish_status: "draft",
          featured,
          sort_order: sortOrder,
          published_at: null,
          display_date: displayDate,
          data,
          version: 1,
          created_by: admin.id,
          updated_by: admin.id,
        })
        .returning({ id: entries.id });

      const id = inserted.id;

      await rewriteTags(tx, id, tags);

      await tx.insert(entryRevisions).values({
        entry_id: id,
        version: 1,
        snapshot: snapshotOf({
          kind,
          slug: base.slug,
          title,
          summary,
          body_md: base.bodyMd,
          body_html: bodyHtml,
          publish_status: "draft",
          featured,
          sort_order: sortOrder,
          published_at: null,
          display_date: displayDate,
          data,
          version: 1,
        }),
        change_note: "创建草稿",
        created_by: admin.id,
      });

      await tx.insert(auditLogs).values({
        actor_id: admin.id,
        action: "entry.create",
        entity_type: "entry",
        entity_id: id,
        detail: { kind, slug: base.slug, title },
      });

      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        fieldErrors: { slug: `slug「${base.slug}」在 ${kind} 分区里已存在` },
        formError: "slug 重复",
      };
    }
    return { ok: false, formError: describeError(error) };
  }

  invalidate(kind, base.slug);
  // 跳转路径必须与列表页链接一致（`/admin/content/<kind>/<slug>`）。
  // 早先这里写成 `/admin/<kind>/<slug>`，而列表页与总览页都链到
  // `/admin/content/...`，两边不一致会出现「创建成功但 404」。
  redirect(`/admin/content/${kind}/${encodeURIComponent(base.slug)}?created=1&id=${entryId}`);
}

/* -------------------------------------------------------------------------- */
/* 保存（草稿 / 已发布内容编辑）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 保存内容（不改变发布状态）。
 *
 * 五、六道关的细节：
 * - 乐观锁：`expectedVersion` 来自表单隐藏域（页面渲染时读到的版本）。
 *   写成功后 `version + 1`，并生成一条新 revision —— 这样「保存」本身
 *   也进历史，恢复时能退回任何一个保存点，而不只是发布点。
 * - 状态保持不变：保存不应该顺手发布（编辑者可能只是想存一下）。
 */
export async function saveEntryAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();

  const entryId = String(formData.get("entryId") ?? "");
  if (!entryId) return { ok: false, formError: "缺少 entryId" };

  const validation = validateEntryForm(formData);
  if (!validation.ok) {
    return { ok: false, fieldErrors: validation.fieldErrors, formError: "表单校验未通过" };
  }

  const { base, data, title, summary, featured, sortOrder, displayDate, tags } = validation;
  const kind = base.kind as EntryKind;

  const bodyHtml = await renderMarkdown(base.bodyMd, { headingOffset: headingOffsetOf(kind) });
  const db = await getAdminDb();

  let previousSlug: string | undefined;
  let nextVersion = base.expectedVersion + 1;

  try {
    const outcome = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(entries)
        .where(eq(entries.id, entryId))
        .limit(1);

      if (!current) return { kind: "missing" as const };
      if (current.version !== base.expectedVersion) {
        return { kind: "conflict" as const, currentVersion: current.version };
      }

      previousSlug = current.slug;
      nextVersion = current.version + 1;

      // blog/diary 的 published_at 只在首次发布时定死；这里改的是展示日期，
      // 若已经发布过，同步 published_at（编辑者改日期就是要改排序位置）。
      const nextPublishedAt =
        current.publish_status === "published" && displayDate
          ? east8Midnight(displayDate)
          : current.published_at;

      const [updated] = await tx
        .update(entries)
        .set({
          slug: base.slug,
          title,
          summary,
          body_md: base.bodyMd,
          body_html: bodyHtml,
          featured,
          sort_order: sortOrder,
          display_date: displayDate,
          published_at: nextPublishedAt,
          data,
          version: nextVersion,
          updated_by: admin.id,
          // 刻意不动 updated_at 的默认值：列上有 defaultNow，UPDATE 不会自动改，
          // 所以显式写 now()。否则「按更新时间排序」在后台永远看不到刚改的内容。
          updated_at: new Date(),
        })
        .where(and(eq(entries.id, entryId), eq(entries.version, base.expectedVersion)))
        .returning({ version: entries.version });

      if (!updated) return { kind: "conflict" as const, currentVersion: current.version };

      await rewriteTags(tx, entryId, tags);

      await tx.insert(entryRevisions).values({
        entry_id: entryId,
        version: nextVersion,
        snapshot: snapshotOf({
          kind,
          slug: base.slug,
          title,
          summary,
          body_md: base.bodyMd,
          body_html: bodyHtml,
          publish_status: current.publish_status,
          featured,
          sort_order: sortOrder,
          published_at: nextPublishedAt,
          display_date: displayDate,
          data,
          version: nextVersion,
        }),
        change_note: base.changeNote ?? "保存修改",
        created_by: admin.id,
      });

      await tx.insert(auditLogs).values({
        actor_id: admin.id,
        action: "entry.save",
        entity_type: "entry",
        entity_id: entryId,
        detail: {
          kind,
          slugBefore: current.slug,
          slugAfter: base.slug,
          versionBefore: current.version,
          versionAfter: nextVersion,
        },
      });

      return { kind: "ok" as const };
    });

    if (outcome.kind === "missing") return { ok: false, formError: "内容不存在或已被删除" };
    if (outcome.kind === "conflict") {
      return {
        ok: false,
        formError: "内容已被其他会话修改，请刷新页面后重试（版本冲突）",
        currentVersion: outcome.currentVersion,
      };
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        fieldErrors: { slug: `slug「${base.slug}」在 ${kind} 分区里已存在` },
        formError: "slug 重复",
      };
    }
    return { ok: false, formError: describeError(error) };
  }

  invalidate(kind, base.slug, previousSlug);
  return { ok: true, message: `已保存（版本 ${nextVersion}）` };
}

/* -------------------------------------------------------------------------- */
/* 状态流转：发布 / 定时 / 归档 / 撤下                                          */
/* -------------------------------------------------------------------------- */

/**
 * 状态流转的公共实现。
 *
 * 方案 §9.5 的顺序在这里严格照做：
 * `校验 → 生成版本快照 → 改状态 → （事务提交）→ 失效缓存 → 写审计`
 *
 * 注意审计写在**事务内**（第 6 道关要求），缓存失效在**事务外**
 * —— 事务内失效会在提交前就把缓存清掉，读请求此时进来会读到旧数据并重新缓存，
 * 结果就是「发布成功了但前台还是旧的」。
 */
async function transitionStatus(
  formData: FormData,
  action: "publish" | "schedule" | "archive" | "unpublish",
): Promise<ActionResult> {
  const admin = await requireAdmin();

  const entryId = String(formData.get("entryId") ?? "");
  const expectedVersion = Number.parseInt(String(formData.get("expectedVersion") ?? ""), 10);
  if (!entryId) return { ok: false, formError: "缺少 entryId" };
  if (!Number.isFinite(expectedVersion) || expectedVersion < 1) {
    return { ok: false, formError: "缺少有效的版本号，请刷新页面重试" };
  }

  let targetStatus: "draft" | "scheduled" | "published" | "archived";
  let scheduledAt: Date | null = null;

  switch (action) {
    case "publish":
      targetStatus = "published";
      break;
    case "unpublish":
      targetStatus = "draft";
      break;
    case "archive":
      targetStatus = "archived";
      break;
    case "schedule": {
      const raw = String(formData.get("scheduledAt") ?? "");
      const parsed = raw ? new Date(raw) : null;
      if (!parsed || Number.isNaN(parsed.getTime())) {
        return { ok: false, fieldErrors: { scheduledAt: "定时发布时间格式不正确" }, formError: "定时时间无效" };
      }
      if (parsed.getTime() <= Date.now()) {
        return {
          ok: false,
          fieldErrors: { scheduledAt: "定时发布时间必须晚于当前时间" },
          formError: "定时时间必须是将来的时间",
        };
      }
      targetStatus = "scheduled";
      scheduledAt = parsed;
      break;
    }
  }

  const db = await getAdminDb();
  let slug = "";
  let kind: EntryKind = "blog";
  let previousStatus = "";

  try {
    const outcome = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(entries)
        .where(eq(entries.id, entryId))
        .limit(1);

      if (!current) return { kind: "missing" as const };
      if (current.version !== expectedVersion) {
        return { kind: "conflict" as const, currentVersion: current.version };
      }

      slug = current.slug;
      kind = current.kind as EntryKind;
      previousStatus = current.publish_status;

      // 发布前的最后一次校验（方案 §9.5 的「校验」环节）。
      // 草稿可能是在旧版本规则下存进去的，发布是它第一次面对读者，
      // 这里必须重新确认它还能通过共享 schema。
      if (targetStatus === "published") {
        const title = current.title.trim();
        const body = current.body_md.trim();
        if (!title) {
          return { kind: "invalid" as const, message: "标题为空，不能发布" };
        }
        if (!body) {
          return { kind: "invalid" as const, message: "正文为空，不能发布" };
        }
      }

      const nextVersion = current.version + 1;

      // published_at 的语义：
      // - 首次发布（原来没有时间）→ blog/diary 取展示日期的东八区零点，其余取此刻；
      // - 已发布过再改 → 保留原时间（不因为「重新发布」而把旧文章顶到最前）。
      // - 定时发布 → 存计划时间，作为「上线时刻」。
      let nextPublishedAt = current.published_at;
      if (targetStatus === "published") {
        if (scheduledAt) {
          nextPublishedAt = scheduledAt;
        } else if (!nextPublishedAt) {
          nextPublishedAt = current.display_date
            ? east8Midnight(current.display_date)
            : new Date();
        }
      }

      const bodyHtml =
        current.body_html ??
        (await renderMarkdown(current.body_md, { headingOffset: headingOffsetOf(kind) }));

      const [updated] = await tx
        .update(entries)
        .set({
          publish_status: targetStatus,
          published_at: nextPublishedAt,
          body_html: bodyHtml,
          version: nextVersion,
          updated_by: admin.id,
          updated_at: new Date(),
        })
        .where(and(eq(entries.id, entryId), eq(entries.version, expectedVersion)))
        .returning({ version: entries.version });

      if (!updated) return { kind: "conflict" as const, currentVersion: current.version };

      // 版本快照：不可变，且恢复历史时依赖它。
      await tx.insert(entryRevisions).values({
        entry_id: entryId,
        version: nextVersion,
        snapshot: snapshotOf({
          ...current,
          publish_status: targetStatus,
          published_at: nextPublishedAt,
          body_html: bodyHtml,
          version: nextVersion,
        }),
        change_note: `状态：${previousStatus} → ${targetStatus}`,
        created_by: admin.id,
      });

      await tx.insert(auditLogs).values({
        actor_id: admin.id,
        action: `entry.${action}`,
        entity_type: "entry",
        entity_id: entryId,
        detail: {
          kind,
          slug,
          from: previousStatus,
          to: targetStatus,
          scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
          versionBefore: current.version,
          versionAfter: nextVersion,
        },
      });

      return { kind: "ok" as const };
    });

    if (outcome.kind === "missing") return { ok: false, formError: "内容不存在或已被删除" };
    if (outcome.kind === "invalid") return { ok: false, formError: outcome.message };
    if (outcome.kind === "conflict") {
      return {
        ok: false,
        formError: "内容已被其他会话修改，请刷新页面后重试（版本冲突）",
        currentVersion: outcome.currentVersion,
      };
    }
  } catch (error) {
    return { ok: false, formError: describeError(error) };
  }

  invalidate(kind, slug);

  const label =
    action === "publish"
      ? "已发布"
      : action === "unpublish"
        ? "已撤回到草稿"
        : action === "archive"
          ? "已归档"
          : `已排入定时（${scheduledAt?.toISOString() ?? ""}）`;

  return { ok: true, message: label };
}

export async function publishEntryAction(formData: FormData): Promise<ActionResult> {
  return transitionStatus(formData, "publish");
}

export async function scheduleEntryAction(formData: FormData): Promise<ActionResult> {
  return transitionStatus(formData, "schedule");
}

export async function archiveEntryAction(formData: FormData): Promise<ActionResult> {
  return transitionStatus(formData, "archive");
}

export async function unpublishEntryAction(formData: FormData): Promise<ActionResult> {
  return transitionStatus(formData, "unpublish");
}

/* -------------------------------------------------------------------------- */
/* 批量归档（方案 §9.2：只允许批量归档，不做批量永久删除）                        */
/* -------------------------------------------------------------------------- */

export async function bulkArchiveAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();

  const ids = formData
    .getAll("entryId")
    .map((value) => String(value))
    .filter((value) => value.length > 0);

  if (ids.length === 0) return { ok: false, formError: "没有选中任何内容" };

  const db = await getAdminDb();
  const affected: { kind: EntryKind; slug: string }[] = [];

  try {
    await db.transaction(async (tx) => {
      for (const id of ids) {
        const [current] = await tx
          .select()
          .from(entries)
          .where(eq(entries.id, id))
          .limit(1);
        if (!current) continue;

        // 逐条走一遍（而不是一条 UPDATE ... IN (...)）：每条都要留快照与审计，
        // 且已归档的不重复处理。
        if (current.publish_status === "archived") continue;

        const nextVersion = current.version + 1;
        await tx
          .update(entries)
          .set({
            publish_status: "archived",
            version: nextVersion,
            updated_by: admin.id,
            updated_at: new Date(),
          })
          .where(eq(entries.id, id));

        await tx.insert(entryRevisions).values({
          entry_id: id,
          version: nextVersion,
          snapshot: snapshotOf({
            ...current,
            publish_status: "archived",
            version: nextVersion,
          }),
          change_note: "批量归档",
          created_by: admin.id,
        });

        await tx.insert(auditLogs).values({
          actor_id: admin.id,
          action: "entry.bulk_archive",
          entity_type: "entry",
          entity_id: id,
          detail: {
            kind: current.kind,
            slug: current.slug,
            from: current.publish_status,
            batchSize: ids.length,
          },
        });

        affected.push({ kind: current.kind as EntryKind, slug: current.slug });
      }
    });
  } catch (error) {
    return { ok: false, formError: describeError(error) };
  }

  for (const item of affected) {
    invalidate(item.kind, item.slug);
  }

  return { ok: true, message: `已归档 ${affected.length} 条内容` };
}

/* -------------------------------------------------------------------------- */
/* 恢复历史版本                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 恢复某个历史版本。
 *
 * 方案 §9.7：「恢复历史版本时生成新版本，不覆盖历史。」
 * 所以这里**不会**删除或改写任何 revision，而是把快照内容作为**新的一版**写回去，
 * 历史链条保持完整（第 N 版恢复到第 3 版 → 产生第 N+1 版，内容等于第 3 版）。
 */
export async function restoreRevisionAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();

  const entryId = String(formData.get("entryId") ?? "");
  const targetVersion = Number.parseInt(String(formData.get("version") ?? ""), 10);
  const expectedVersion = Number.parseInt(String(formData.get("expectedVersion") ?? ""), 10);

  if (!entryId) return { ok: false, formError: "缺少 entryId" };
  if (!Number.isFinite(targetVersion) || targetVersion < 1) {
    return { ok: false, formError: "缺少要恢复的版本号" };
  }
  if (!Number.isFinite(expectedVersion) || expectedVersion < 1) {
    return { ok: false, formError: "缺少当前版本号，请刷新页面重试" };
  }

  const db = await getAdminDb();
  let kind: EntryKind = "blog";
  let slug = "";

  try {
    const outcome = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(entries)
        .where(eq(entries.id, entryId))
        .limit(1);
      if (!current) return { kind: "missing" as const };
      if (current.version !== expectedVersion) {
        return { kind: "conflict" as const, currentVersion: current.version };
      }

      const [revision] = await tx
        .select()
        .from(entryRevisions)
        .where(
          and(
            eq(entryRevisions.entry_id, entryId),
            eq(entryRevisions.version, targetVersion),
          ),
        )
        .limit(1);

      if (!revision) return { kind: "noRevision" as const };

      const snapshot = revision.snapshot as Record<string, unknown>;
      kind = current.kind as EntryKind;
      slug = String(snapshot.slug ?? current.slug);

      const nextVersion = current.version + 1;
      const bodyMd = String(snapshot.body_md ?? current.body_md);
      const restoredKind = String(snapshot.kind ?? current.kind) as EntryKind;
      const bodyHtml = await renderMarkdown(bodyMd, {
        headingOffset: headingOffsetOf(restoredKind),
      });

      const restoredPublishedAtRaw = snapshot.published_at;
      const restoredPublishedAt =
        typeof restoredPublishedAtRaw === "string"
          ? new Date(restoredPublishedAtRaw)
          : current.published_at;

      const [updated] = await tx
        .update(entries)
        .set({
          slug,
          title: String(snapshot.title ?? current.title),
          summary: String(snapshot.summary ?? current.summary),
          body_md: bodyMd,
          body_html: bodyHtml,
          // 状态**不**回滚：恢复内容不应该把已归档的文章重新发布出去。
          // 复制一份内容、状态保持现状，是恢复功能最不容易出事的语义。
          featured: Boolean(snapshot.featured ?? current.featured),
          sort_order: Number(snapshot.sort_order ?? current.sort_order),
          published_at: restoredPublishedAt,
          display_date:
            typeof snapshot.display_date === "string" ? snapshot.display_date : current.display_date,
          data: (snapshot.data ?? current.data) as Record<string, unknown>,
          version: nextVersion,
          updated_by: admin.id,
          updated_at: new Date(),
        })
        .where(and(eq(entries.id, entryId), eq(entries.version, expectedVersion)))
        .returning({ version: entries.version });

      if (!updated) return { kind: "conflict" as const, currentVersion: current.version };

      // 标签不在快照里（它们在 tags / entry_tags 两张表）。
      // 恢复历史版本时**保持当前标签不动**：标签的变更历史没有被快照，
      // 拿「当前标签」比拿「恢复点的标签」更不容易丢数据。这条限制写进审计。
      await tx.insert(entryRevisions).values({
        entry_id: entryId,
        version: nextVersion,
        snapshot: snapshotOf({
          kind: restoredKind,
          slug,
          title: String(snapshot.title ?? current.title),
          summary: String(snapshot.summary ?? current.summary),
          body_md: bodyMd,
          body_html: bodyHtml,
          publish_status: current.publish_status,
          featured: Boolean(snapshot.featured ?? current.featured),
          sort_order: Number(snapshot.sort_order ?? current.sort_order),
          published_at: restoredPublishedAt,
          display_date:
            typeof snapshot.display_date === "string" ? snapshot.display_date : current.display_date,
          data: (snapshot.data ?? current.data) as Record<string, unknown>,
          version: nextVersion,
        }),
        change_note: `恢复自版本 ${targetVersion}`,
        created_by: admin.id,
      });

      await tx.insert(auditLogs).values({
        actor_id: admin.id,
        action: "entry.restore",
        entity_type: "entry",
        entity_id: entryId,
        detail: {
          kind: restoredKind,
          slug,
          restoredFrom: targetVersion,
          versionBefore: current.version,
          versionAfter: nextVersion,
          tagsPreserved: true,
        },
      });

      return { kind: "ok" as const };
    });

    if (outcome.kind === "missing") return { ok: false, formError: "内容不存在或已被删除" };
    if (outcome.kind === "noRevision") return { ok: false, formError: "该版本不存在" };
    if (outcome.kind === "conflict") {
      return {
        ok: false,
        formError: "内容已被其他会话修改，请刷新页面后重试（版本冲突）",
        currentVersion: outcome.currentVersion,
      };
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, formError: "恢复失败：目标 slug 已被其他内容占用" };
    }
    return { ok: false, formError: describeError(error) };
  }

  invalidate(kind, slug);
  return { ok: true, message: `已恢复到版本 ${targetVersion}（内容已作为新版本保存）` };
}

/* -------------------------------------------------------------------------- */
/* 登出                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 后台登出。走 Auth.js 的 signOut，会真正删掉 sessions 行。
 *
 * **登出前必须先补写审计**：`events.signOut` 拿不到 userId（`deleteSession`
 * 契约是 `void`，事件里的 `message.session` 恒为 undefined），而等 `signOut()`
 * 返回时 sessions 行已经没了，再查也查不到。所以顺序是「先记录，再登出」。
 */
export async function adminSignOutAction(): Promise<void> {
  const { recordSignOutBeforeClearing, signOut } = await import("../auth");
  await recordSignOutBeforeClearing();
  await signOut({ redirectTo: "/login" });
}
