/**
 * blog 分区 schema。
 *
 * 字段来源：apps/web/content/blog/*.md（4 个真实文件）+ desktop schemaService.ts 的 blog 声明。
 * 差异记录见 docs/recon-p0.md §2.1 / §2.5。
 */

import { z } from 'zod';

import { zBooleanFlag, zDate, zNonEmpty, zOptionalString, zStringSet } from '../primitives';

/**
 * 注意 category 的默认值处理：
 *
 * 站点侧（apps/web/src/lib/posts.ts:129-132）把缺失/空串归一成「未分类」，
 * 但那是**页面层的静默降级**，数据层没有默认值。这里把默认值提到 schema 层，
 * 让「未分类」成为契约的一部分，避免不同消费端各自实现一遍。
 */
export const blogSchema = z.object({
  title: zNonEmpty,
  description: zNonEmpty,
  date: zDate,
  category: z.preprocess(
    (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
    z.string().trim().min(1).default('未分类'),
  ),
  tags: zStringSet,
  cover: zOptionalString,
  draft: zBooleanFlag,
});

export type BlogEntry = z.infer<typeof blogSchema>;
