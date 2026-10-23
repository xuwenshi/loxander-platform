import "server-only";

import { desc, eq } from "drizzle-orm";

import { media } from "../../../../../db/schema";
import { getAdminDb } from "./db";

/**
 * `media` 表的数据访问层。
 *
 * ── 为什么单独一层，而不是让页面/action 直接写 drizzle ────────────────
 * 三处调用方（上传 action、删除 action、`/admin/media` 页面）需要的是同一份
 * 行形状。如果各自 `select` 一遍，某天给表加一列（比如 `focal_x`）就得改三处，
 * 而且很容易漏掉一处 —— 漏掉的表现是「页面看不到新字段」，不会报错。
 * 这里把「表列 → 前端行」的映射收在一处，改表只改这里。
 *
 * ── 为什么行里用 camelCase，而表列是 snake_case ─────────────────────
 * 表列名跟着 SQL 习惯（`mime_type`），React 组件与页面数据按 TS 习惯（`mimeType`）。
 * 边界就放在这一层：对外只暴露 camelCase，组件不需要知道数据库怎么命名。
 * 这也避免把 `size_bytes`（bigint，drizzle 里 `mode: 'number'`）这种细节泄漏出去。
 */

/** 一行媒体。字段顺序与 `media` 表一致，便于对照。 */
export interface MediaRow {
  id: string;
  path: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  alt: string;
  createdAt: Date;
}

/** 表行 → 对外行。唯一一处做字段改名的地方。 */
function toMediaRow(row: {
  id: string;
  path: string;
  url: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  alt: string;
  created_at: Date;
}): MediaRow {
  return {
    id: row.id,
    path: row.path,
    url: row.url,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    alt: row.alt,
    createdAt: row.created_at,
  };
}

/**
 * 全部媒体，新上传的在前。
 *
 * 不加分页：媒体库当前是个位数到几十张的量级，分页会引入「第 2 页的图被删掉后
 * 页码越界」这类问题，而收益为零。真到几百张时，正确的做法是服务端分页 +
 * 按 `created_at` 的游标，而不是在这里加 `limit/offset` —— 留待那时再说。
 */
export async function listMedia(): Promise<MediaRow[]> {
  const db = await getAdminDb();
  const rows = await db.select().from(media).orderBy(desc(media.created_at));
  return rows.map(toMediaRow);
}

/** 按 id 取一行，不存在返回 `null`（不抛错：调用方要用它区分「没这张图」和「查询炸了」）。 */
export async function getMediaById(id: string): Promise<MediaRow | null> {
  const db = await getAdminDb();
  const rows = await db.select().from(media).where(eq(media.id, id)).limit(1);
  const row = rows[0];
  return row ? toMediaRow(row) : null;
}

/**
 * 插入一行媒体记录，返回**落库后**的行。
 *
 * 为什么用 `returning()` 而不是「插入后自己拼返回值」：`id`（`gen_random_uuid()`）
 * 和 `created_at`（`now()`）都是数据库侧生成的默认值，应用层拼不出来。少了
 * `returning()` 就只能再查一次，多一次往返且两次之间可能被并发删除。
 *
 * `width` / `height` / `alt` 可选：SVG 嗅探不出尺寸（`image-info.ts` 里 SVG 分支
 * 只返回 mimeType），`alt` 允许先空着、之后再补。
 */
export async function insertMedia(row: {
  path: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  alt?: string;
}): Promise<MediaRow> {
  const db = await getAdminDb();
  const inserted = await db
    .insert(media)
    .values({
      path: row.path,
      url: row.url,
      mime_type: row.mimeType,
      size_bytes: row.sizeBytes,
      // `?? null` 而不是 `|| null`：宽度 0 在语义上是「算不出来」，
      // 但用 `||` 会把 0 也变成 null，将来若真有 0 宽的边界图会无从分辨。
      width: row.width ?? null,
      height: row.height ?? null,
      alt: row.alt ?? "",
    })
    .returning();

  return toMediaRow(inserted[0]);
}

/**
 * 删掉一行媒体记录。
 *
 * 只删数据库，**不碰文件** —— 文件删除由 `media-actions.ts` 在引用检查通过后
 * 单独调用 `deleteImage()`。这个顺序很重要：先删文件再删行，若删行失败就留下
 * 「有记录、没文件」的破图；先删行再删文件，最坏情况是把文件留在存储里当成
 * 垃圾（可清理），不会让用户看到破图。
 */
export async function deleteMediaRow(id: string): Promise<void> {
  const db = await getAdminDb();
  await db.delete(media).where(eq(media.id, id));
}
