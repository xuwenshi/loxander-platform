import "server-only";

import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  auditLogs,
  entries,
  entryRevisions,
  entryTags,
  PUBLISH_STATUSES,
  ENTRY_KINDS_DB,
  tags as tagsTable,
  users,
  type BlogData,
  type DiaryData,
  type GoalsData,
  type ProjectsData,
} from "../../../../../db/schema";
import { getAdminDb } from "./db";

/**
 * 后台**读**路径。
 *
 * ── 与 `lib/sources/db.ts` 的分工 ────────────────────────────────────
 * `lib/sources/db.ts` 是**公开站点**的读路径：过滤 `publish_status='published'`、
 * 走 `"use cache"`、把行裁成 `PostMeta` 这类前台类型。
 * 后台正相反：要看到**全部**状态（草稿/定时/已归档）、**绝不能缓存**
 * （否则自己刚改完看不出来，见方案 §8.3「后台：动态渲染，禁止缓存敏感数据」）、
 * 而且要拿到 `version` / `updated_at` / `created_by` 这些前台不需要的列。
 *
 * 两个读路径各自独立是刻意的：把它们合并成「一个函数带一堆 flag」，
 * 迟早会出现前台误用后台参数、把草稿泄漏到公开页面的情况。
 */

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

export type PublishStatus = (typeof PUBLISH_STATUSES)[number];
export type EntryKindDb = (typeof ENTRY_KINDS_DB)[number];

/** 列表页只取摘要列 —— 正文可能几十 KB，列表拉全量正文会明显拖慢首屏。 */
export interface EntryListRow {
  id: string;
  kind: EntryKindDb;
  slug: string;
  title: string;
  summary: string;
  publishStatus: PublishStatus;
  featured: boolean;
  sortOrder: number;
  publishedAt: Date | null;
  displayDate: string | null;
  version: number;
  updatedAt: Date;
  createdAt: Date;
}

/** 编辑页要的全部列（含正文与 data）。 */
export interface EntryDetailRow extends EntryListRow {
  bodyMd: string;
  data: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface ListEntriesOptions {
  kind?: EntryKindDb | "all";
  status?: PublishStatus | "all";
  /** 关键词：同时匹配 title 与 slug（大小写不敏感）。 */
  query?: string;
  sort?: "updated" | "published" | "title";
  direction?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface ListEntriesResult {
  rows: EntryListRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/* -------------------------------------------------------------------------- */
/* 列表                                                                        */
/* -------------------------------------------------------------------------- */

/** 把 `?x=` 之类的外部字符串收敛到已知枚举；非法值一律退回 `all`，不抛错。 */
export function parseKindFilter(value: string | undefined): EntryKindDb | "all" {
  return value && (ENTRY_KINDS_DB as readonly string[]).includes(value)
    ? (value as EntryKindDb)
    : "all";
}

export function parseStatusFilter(value: string | undefined): PublishStatus | "all" {
  return value && (PUBLISH_STATUSES as readonly string[]).includes(value)
    ? (value as PublishStatus)
    : "all";
}

export function parseSort(
  value: string | undefined,
): NonNullable<ListEntriesOptions["sort"]> {
  return value === "published" || value === "title" ? value : "updated";
}

export function parseDirection(value: string | undefined): "asc" | "desc" {
  return value === "asc" ? "asc" : "desc";
}

/** 页码收敛：非数字/小于 1 一律回 1；不设上限（越界由结果自己的 total 决定）。 */
export function parsePage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function parsePageSize(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * 关键词转 LIKE 模式。
 *
 * 必须转义 `%` `_` `\` 三个 LIKE 元字符 —— 否则用户在搜索框里输入一个 `%`
 * 就等于「匹配一切」，那不是搜索，是绕过筛选。
 */
function toLikePattern(raw: string): string {
  const escaped = raw.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

function buildWhere(options: ListEntriesOptions): SQL | undefined {
  const clauses: SQL[] = [];

  if (options.kind && options.kind !== "all") {
    clauses.push(eq(entries.kind, options.kind));
  }

  if (options.status && options.status !== "all") {
    clauses.push(eq(entries.publish_status, options.status));
  }

  const keyword = options.query?.trim();
  if (keyword) {
    const pattern = toLikePattern(keyword);
    const match = or(ilike(entries.title, pattern), ilike(entries.slug, pattern));
    if (match) clauses.push(match);
  }

  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : and(...clauses);
}

function buildOrder(options: ListEntriesOptions) {
  const direction = options.direction === "asc" ? asc : desc;
  switch (options.sort) {
    case "published":
      // `published_at` 可为 NULL（草稿）。Postgres 默认 DESC 时 NULLS FIRST，
      // 会让一堆草稿顶在列表最上面。这里用 `NULLS LAST` 把它们压到底。
      return [
        sql`${entries.published_at} ${sql.raw(options.direction === "asc" ? "ASC NULLS FIRST" : "DESC NULLS LAST")}`,
        desc(entries.updated_at),
      ];
    case "title":
      return [direction(entries.title), desc(entries.updated_at)];
    default:
      return [direction(entries.updated_at)];
  }
}

export async function listEntries(
  options: ListEntriesOptions = {},
): Promise<ListEntriesResult> {
  const db = await getAdminDb();

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const where = buildWhere(options);

  // 先数总数 —— 分页器要显示「共 N 条」，且页码越界时要能回退到最后一页。
  const [totalRow] = await db
    .select({ value: count() })
    .from(entries)
    .where(where);

  const total = totalRow?.value ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);

  const rows = await db
    .select({
      id: entries.id,
      kind: entries.kind,
      slug: entries.slug,
      title: entries.title,
      summary: entries.summary,
      publishStatus: entries.publish_status,
      featured: entries.featured,
      sortOrder: entries.sort_order,
      publishedAt: entries.published_at,
      displayDate: entries.display_date,
      version: entries.version,
      updatedAt: entries.updated_at,
      createdAt: entries.created_at,
    })
    .from(entries)
    .where(where)
    .orderBy(...buildOrder(options))
    .limit(pageSize)
    .offset((safePage - 1) * pageSize);

  return {
    rows: rows as EntryListRow[],
    total,
    page: safePage,
    pageSize,
    pageCount,
  };
}

/* -------------------------------------------------------------------------- */
/* 详情                                                                        */
/* -------------------------------------------------------------------------- */

/** 按 kind + slug 取一行**未过滤状态**的内容（后台要能编辑草稿）。 */
export async function getEntryDetail(
  kind: EntryKindDb,
  slug: string,
): Promise<EntryDetailRow | null> {
  const db = await getAdminDb();
  const rows = await db
    .select()
    .from(entries)
    .where(and(eq(entries.kind, kind), eq(entries.slug, slug)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    kind: row.kind as EntryKindDb,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    publishStatus: row.publish_status as PublishStatus,
    featured: row.featured,
    sortOrder: row.sort_order,
    publishedAt: row.published_at,
    displayDate: row.display_date,
    version: row.version,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    bodyMd: row.body_md,
    data: (row.data ?? {}) as Record<string, unknown>,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

/** 按 id 取详情（恢复历史版本后需要按 id 重取，因为 kind/slug 可能被改过）。 */
export async function getEntryById(id: string): Promise<EntryDetailRow | null> {
  const db = await getAdminDb();
  const rows = await db.select().from(entries).where(eq(entries.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind as EntryKindDb,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    publishStatus: row.publish_status as PublishStatus,
    featured: row.featured,
    sortOrder: row.sort_order,
    publishedAt: row.published_at,
    displayDate: row.display_date,
    version: row.version,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    bodyMd: row.body_md,
    data: (row.data ?? {}) as Record<string, unknown>,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

/**
 * 读某个 entry 的标签名（按 `tag_order` 升序）。
 *
 * ── 为什么单独一个查询而不是 JOIN 进 getEntryDetail ──────────────────
 * `getEntryDetail` 只被编辑页用一次，标签也只在编辑页需要；把 JOIN 塞进
 * 详情查询会让列表页（走 `listEntries`，不带这个 JOIN）与详情页拿到形状
 * 不同的对象，反而更容易出错。这里显式多一次查询，代价是一次主键索引查找。
 *
 * ── 为什么必须带 orderBy ──────────────────────────────────────────
 * `tag_order` 就是「frontmatter 里写的顺序」，也就是 P2 导入时记下的下标。
 * 不排序的话 Postgres 返回顺序取决于物理存储，编辑页回填表单时标签顺序会乱，
 * 用户一保存就把顺序永久改掉（`rewriteTags` 按数组下标重写 `tag_order`）。
 */
export async function listEntryTagNames(entryId: string): Promise<string[]> {
  const db = await getAdminDb();
  const rows = await db
    .select({ name: tagsTable.name })
    .from(entryTags)
    .innerJoin(tagsTable, eq(tagsTable.id, entryTags.tag_id))
    .where(eq(entryTags.entry_id, entryId))
    .orderBy(asc(entryTags.tag_order), asc(tagsTable.name));

  return rows.map((row) => row.name);
}

/* -------------------------------------------------------------------------- */
/* 类型专属字段的形状收窄                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `entries.data` 是 `jsonb`，运行期形状由 `db/schema.ts` 末尾的四个 interface 约定。
 *
 * 后台编辑页要按类型渲染不同表单，所以这里给出**只读的收窄视图**。
 * 刻意不引 Zod 再校验一遍：写入侧的 Zod 校验在 `actions.ts`，
 * 读取侧再校验一次只会让「库里存了脏数据」这件事从「看得见」变成「渲染崩」。
 * 缺字段时按 schema 的默认值补齐，让表单永远有可用的初值。
 */
export function readBlogData(data: Record<string, unknown>): Required<Pick<BlogData, "category">> &
  Omit<BlogData, "category"> {
  return {
    category: typeof data.category === "string" ? data.category : "未分类",
    cover: typeof data.cover === "string" ? data.cover : undefined,
    coverWidth: typeof data.coverWidth === "number" ? data.coverWidth : undefined,
    coverHeight: typeof data.coverHeight === "number" ? data.coverHeight : undefined,
  };
}

export function readDiaryData(data: Record<string, unknown>): DiaryData {
  return {
    mood: typeof data.mood === "string" ? data.mood : undefined,
  };
}

export function readProjectsData(data: Record<string, unknown>): ProjectsData {
  return {
    techStack: Array.isArray(data.techStack)
      ? data.techStack.filter((item): item is string => typeof item === "string")
      : [],
    status: typeof data.status === "string" ? data.status : "in-progress",
    period: typeof data.period === "string" ? data.period : undefined,
    role: typeof data.role === "string" ? data.role : undefined,
    github: typeof data.github === "string" ? data.github : undefined,
    demo: typeof data.demo === "string" ? data.demo : undefined,
    article: typeof data.article === "string" ? data.article : undefined,
  };
}

export function readGoalsData(data: Record<string, unknown>): GoalsData {
  const rawMilestones = Array.isArray(data.milestones) ? data.milestones : [];
  return {
    horizon: typeof data.horizon === "string" ? data.horizon : "short",
    status: typeof data.status === "string" ? data.status : "planned",
    progress: typeof data.progress === "number" ? data.progress : 0,
    period: typeof data.period === "string" ? data.period : undefined,
    milestones: rawMilestones
      .filter(
        (item): item is { title: string; done: boolean } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { title?: unknown }).title === "string",
      )
      .map((item) => ({ title: item.title, done: Boolean(item.done) })),
  };
}

/* -------------------------------------------------------------------------- */
/* 版本历史                                                                    */
/* -------------------------------------------------------------------------- */

export interface RevisionRow {
  id: number;
  version: number;
  changeNote: string | null;
  createdAt: Date;
  createdBy: string | null;
}

export async function listRevisions(entryId: string): Promise<RevisionRow[]> {
  const db = await getAdminDb();
  const rows = await db
    .select({
      id: entryRevisions.id,
      version: entryRevisions.version,
      changeNote: entryRevisions.change_note,
      createdAt: entryRevisions.created_at,
      createdBy: entryRevisions.created_by,
    })
    .from(entryRevisions)
    .where(eq(entryRevisions.entry_id, entryId))
    .orderBy(desc(entryRevisions.version));

  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

export interface RevisionSnapshot {
  id: number;
  version: number;
  changeNote: string | null;
  createdAt: Date;
  snapshot: Record<string, unknown>;
}

export async function getRevision(
  entryId: string,
  version: number,
): Promise<RevisionSnapshot | null> {
  const db = await getAdminDb();
  const rows = await db
    .select()
    .from(entryRevisions)
    .where(
      and(eq(entryRevisions.entry_id, entryId), eq(entryRevisions.version, version)),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: Number(row.id),
    version: row.version,
    changeNote: row.change_note,
    createdAt: row.created_at,
    snapshot: (row.snapshot ?? {}) as Record<string, unknown>,
  };
}

/* -------------------------------------------------------------------------- */
/* 审计日志                                                                    */
/* -------------------------------------------------------------------------- */

export interface AuditRow {
  id: number;
  actorId: string | null;
  actorLogin: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: Record<string, unknown>;
  createdAt: Date;
}

/** 审计日志按时间倒序，分页读。`action` 前缀筛选（如 `entry.`）可选。 */
export async function listAuditLogs(options: {
  page?: number;
  pageSize?: number;
  actionPrefix?: string;
} = {}): Promise<{ rows: AuditRow[]; total: number; page: number; pageCount: number }> {
  const db = await getAdminDb();
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(options.pageSize ?? 50, MAX_PAGE_SIZE);

  const where = options.actionPrefix
    ? ilike(auditLogs.action, toLikePattern(options.actionPrefix))
    : undefined;

  const [totalRow] = await db
    .select({ value: count() })
    .from(auditLogs)
    .where(where);
  const total = totalRow?.value ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);

  const rows = await db
    .select({
      id: auditLogs.id,
      actorId: auditLogs.actor_id,
      actorLogin: users.github_login,
      action: auditLogs.action,
      entityType: auditLogs.entity_type,
      entityId: auditLogs.entity_id,
      detail: auditLogs.detail,
      createdAt: auditLogs.created_at,
    })
    .from(auditLogs)
    // LEFT JOIN 而不是 INNER JOIN：`actor_id` 可空（系统动作、或管理员账号被删后
    // 被 `ON DELETE SET NULL` 置空），INNER JOIN 会把这些行整条吞掉。
    .leftJoin(users, eq(users.id, auditLogs.actor_id))
    .where(where)
    .orderBy(desc(auditLogs.created_at), desc(auditLogs.id))
    .limit(pageSize)
    .offset((safePage - 1) * pageSize);

  return {
    rows: rows.map((row) => ({
      ...row,
      id: Number(row.id),
      detail: (row.detail ?? {}) as Record<string, unknown>,
    })),
    total,
    page: safePage,
    pageCount,
  };
}

/* -------------------------------------------------------------------------- */
/* 仪表盘统计                                                                  */
/* -------------------------------------------------------------------------- */

export interface EntryStatRow {
  kind: EntryKindDb;
  status: PublishStatus;
  value: number;
}

/** 一次 GROUP BY 拿到「类型 × 状态」的计数矩阵，仪表盘与标签页角标都用它。 */
export async function countEntriesByKindAndStatus(): Promise<EntryStatRow[]> {
  const db = await getAdminDb();
  const rows = await db
    .select({
      kind: entries.kind,
      status: entries.publish_status,
      value: count(),
    })
    .from(entries)
    .groupBy(entries.kind, entries.publish_status);

  return rows.map((row) => ({
    kind: row.kind as EntryKindDb,
    status: row.status as PublishStatus,
    value: row.value,
  }));
}
