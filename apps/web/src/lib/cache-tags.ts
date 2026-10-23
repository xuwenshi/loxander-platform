/**
 * 缓存标签的**唯一定义处**。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * Next 16 的 `cacheTag()` / `revalidateTag()` 靠字符串配对：打标签的地方
 * 与失效的地方必须是**同一个字符串**，写错一个字符就是「发布后前台纹丝不动」，
 * 而且没有任何报错。所以标签名不能散落在 `sources/db.ts` 与后台代码里各写一份，
 * 必须集中到这里，两侧都从这里取。
 *
 * ── 标签命名（与方案 §14.3 一致）────────────────────────────────────
 * ```text
 * entry:<kind>:<slug>   单条内容      例：entry:blog:rag-chunking-strategies
 * entries:<kind>        某个分区的列表 例：entries:blog
 * entries:all           跨分区（首页、星图、关于、sitemap、RSS）
 * ```
 * 方案原文写的是 `entry:${kind}:${slug}` / `entries:${kind}` / `sitemap`；
 * 这里把 `sitemap` 统一并进 `entries:all` —— sitemap 覆盖的就是「全部已发布内容」，
 * 给它单独一个标签只会在发布时多一行 `revalidateTag` 而没有任何区分价值。
 *
 * ── 为什么不在这里做失效 ────────────────────────────────────────────
 * `revalidateTag()` 只能在 Server Action / Route Handler 里调用（见
 * `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidateTag.md`
 * 「revalidateTag can be called in Server Functions and Route Handlers」）。
 * P3 没有后台、没有发布动作，所以本文件**只产出标签字符串**，
 * 真正的 `revalidateTag` 调用点等 P4 的后台发布流程来写。
 */

import type { EntryKind } from "@loxander/content-core";

/** 单条内容的缓存标签。 */
export function entryTag(kind: EntryKind, slug: string): string {
  return `entry:${kind}:${slug}`;
}

/** 某个分区列表的缓存标签。 */
export function entriesTag(kind: EntryKind): string {
  return `entries:${kind}`;
}

/**
 * 跨分区的「全部内容」缓存标签。
 *
 * 用于首页 / 星图 / 关于（同时读文章 + 项目）、sitemap、RSS ——
 * 它们的内容来自多个分区，任何一个分区变动都该让它们失效。
 */
export const ALL_ENTRIES_TAG = "entries:all";

/**
 * 一次发布要失效的全部标签。
 *
 * P4 的后台发布流程提交事务后应当遍历这个数组调用
 * `revalidateTag(tag, "max")`（Next 16 已是**两参数**签名，
 * 单参数形式已废弃 —— 见 `revalidateTag.md` 的 Parameters 一节）。
 *
 * 为什么不直接在这里调用：调用点必须在 Server Action / Route Handler 内，
 * 本文件被 `"use cache"` 作用域 import，放调用会当场抛
 * `createCacheTagOutsideUseCacheError` 同族的错误。
 */
export function tagsToRevalidateOnPublish(kind: EntryKind, slug: string): string[] {
  return [entryTag(kind, slug), entriesTag(kind), ALL_ENTRIES_TAG];
}
