/**
 * diary 分区 schema。
 *
 * 字段来源：apps/web/content/diary/*.md（1 个真实文件）+ desktop schemaService.ts 的 diary 声明。
 *
 * 注意字段名差异：diary 用 `summary`，不是 blog/projects 的 `description`。
 */

import { z } from 'zod';

import { zBooleanFlag, zDate, zNonEmpty, zOptionalString, zStringSet } from '../primitives';

export const diarySchema = z.object({
  title: zNonEmpty,
  /**
   * diary 用 `summary` 而非 `description`。
   * 见 apps/web/src/lib/diary.ts:86 与 desktop schemaService.ts:61。
   */
  summary: zNonEmpty,
  /**
   * 日期必须两端锚定。
   *
   * 站点现状（apps/web/src/lib/diary.ts:57）用的是 `/^\d{4}-\d{2}-\d{2}/`，
   * **没有 `$`**，因此 `2026-10-12xyz` 也能通过。这里补上 `$`（zDate 已含），
   * 与 desktop `validateService.ts:35` 的 DATE_RE 一致。
   */
  date: zDate,
  mood: zOptionalString,
  tags: zStringSet,
  draft: zBooleanFlag,
});

export type DiaryEntry = z.infer<typeof diarySchema>;
