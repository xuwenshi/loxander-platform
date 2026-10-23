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
 * 标签页（`/tags`、`/tags/[tag]`）与站内搜索（`/search`）的缓存标签（P5 新增）。
 *
 * ── 为什么单独一个标签，而不是复用 `entries:blog` ────────────────────
 * 标签页与搜索页的数据**完全派生自文章列表**，看起来复用 `entries:blog`
 * 就够了。但它们与列表页有一处关键差异：列表页的缓存内容里只有文章本身，
 * 而标签页还带着「有哪些标签、每个标签几篇」这份聚合结果。
 *
 * 更要紧的是搜索：方案 §14.2 把搜索定成「动态查询」，**不缓存**。
 * 如果搜索页也打 `entries:blog`，那就会在缓存里出现一份
 * 「按上次查询词排好序」的结果 —— 下一个查询词进来读到它就是错的。
 * 所以即使将来给搜索加缓存，也必须用**携带查询词**的独立标签，不能复用分区标签。
 *
 * 当前 `/search` 不声明 `"use cache"`（见 `app/(site)/search/page.tsx`），
 * 这个常量留给将来真要缓存时用，且名字已经表明范围，不会误用。
 */
export const TAGS_INDEX_TAG = "tags:index";

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
 *
 * P5 补上 `TAGS_INDEX_TAG`：发布/归档会改变标签集合与每个标签的篇数，
 * 所以标签页的聚合缓存必须一起失效。
 */
export function tagsToRevalidateOnPublish(kind: EntryKind, slug: string): string[] {
  return [entryTag(kind, slug), entriesTag(kind), ALL_ENTRIES_TAG, TAGS_INDEX_TAG];
}
