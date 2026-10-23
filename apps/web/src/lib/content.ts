/**
 * 页面层的**唯一**内容入口。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────
 * P2 已经交付了 `lib/content-source.ts` 的 `ContentSource` 接口与两个实现
 * （`sources/markdown.ts` 纯转调四个旧 lib、`sources/db.ts` 读 Postgres），
 * 但页面层仍在直接 `import ... from "@/lib/posts"` —— 也就是说
 * `CONTENT_SOURCE=db` 到今天为止**没有任何实际效果**。
 *
 * 本文件就是那道开关：页面只认这里导出的函数名，
 * 内部转调 `getContentSource()`，具体走文件还是走库由 `CONTENT_SOURCE` 决定。
 *
 * ── 三条硬规矩 ──────────────────────────────────────────────────────
 * 1. **每个函数只做一件事：转发。** 不排序、不过滤、不补字段、不兜底。
 *    一旦这里出现业务逻辑，它就变成「markdown 行为 / db 行为」之外的
 *    **第三个实现**，`db/compare.ts` 与 14 条双实现等价测试立刻失去参照意义。
 * 2. **签名与旧 lib 逐个对齐**，只有一处形态差异：全部变成 `async`。
 *    旧 lib 里 12 个函数是同步的（`getAllPosts()` 返回数组），这里统一返回 Promise ——
 *    因为 db 实现根本不可能同步。页面层为此要加 `await`，这是 P3 的主要改动量。
 * 3. **不 `export` 四个旧 lib 的任何东西**。页面层不该再有第二条路。
 *
 * ── 缓存边界没有变 ──────────────────────────────────────────────────
 * `"use cache"` 仍然声明在实现侧（`lib/posts.ts:161` 等四处、
 * `sources/db.ts` 的四条详情路径），本文件**不加** `"use cache"`：
 * 转发函数本身没有计算量，加一层只会多一份缓存键与一层失效难度。
 */

import "server-only";

import { getContentSource } from "./content-source";
import type {
  DiaryEntry,
  DiaryMeta,
  Goal,
  Post,
  PostMeta,
  Project,
  ProjectMeta,
  TagCount,
} from "@/types";

/* -------------------------------------------------------------------------- */
/* blog                                                                        */
/* -------------------------------------------------------------------------- */

/** 已知的 blog slug（**不过滤草稿**，供 `projects.article` 引用完整性检查用）。 */
export async function getBlogSlugs(): Promise<string[]> {
  return (await getContentSource()).getBlogSlugs();
}

/** 全部文章元信息，按日期倒序。 */
export async function getAllPosts(): Promise<PostMeta[]> {
  return (await getContentSource()).getAllPosts();
}

/** 最新 N 篇文章（首页 / 星图用）。 */
export async function getRecentPosts(limit?: number): Promise<PostMeta[]> {
  return (await getContentSource()).getRecentPosts(limit);
}

/** 单篇文章（含渲染后的 HTML 与 TOC），不存在返回 `null`。 */
export async function getPost(slug: string): Promise<Post | null> {
  return (await getContentSource()).getPost(slug);
}

/** 上一篇 / 下一篇。 */
export async function getAdjacentPosts(slug: string): Promise<{
  prev: PostMeta | null;
  next: PostMeta | null;
}> {
  return (await getContentSource()).getAdjacentPosts(slug);
}

/** 相关文章（标签重合优先，其次同分类）。 */
export async function getRelatedPosts(slug: string, limit?: number): Promise<PostMeta[]> {
  return (await getContentSource()).getRelatedPosts(slug, limit);
}

/** 全部标签及数量。 */
export async function getAllTags(): Promise<TagCount[]> {
  return (await getContentSource()).getAllTags();
}

/** 全部分类及数量。 */
export async function getAllCategories(): Promise<TagCount[]> {
  return (await getContentSource()).getAllCategories();
}

/* -------------------------------------------------------------------------- */
/* projects                                                                    */
/* -------------------------------------------------------------------------- */

/** 全部项目元信息（按 `order` 升序）。 */
export async function getAllProjects(): Promise<ProjectMeta[]> {
  return (await getContentSource()).getAllProjects();
}

/** 精选项目（无精选时退回全部）。 */
export async function getFeaturedProjects(limit?: number): Promise<ProjectMeta[]> {
  return (await getContentSource()).getFeaturedProjects(limit);
}

/** 单个项目（含渲染后的 HTML 与 TOC），不存在返回 `null`。 */
export async function getProject(slug: string): Promise<Project | null> {
  return (await getContentSource()).getProject(slug);
}

/* -------------------------------------------------------------------------- */
/* diary                                                                       */
/* -------------------------------------------------------------------------- */

/** 全部日记元信息（按日期倒序）。 */
export async function getAllDiaryEntries(): Promise<DiaryMeta[]> {
  return (await getContentSource()).getAllDiaryEntries();
}

/** 可供 `generateStaticParams` 使用的日记 slug 列表。 */
export async function getDiarySlugs(): Promise<string[]> {
  return (await getContentSource()).getDiarySlugs();
}

/** 单篇日记（含渲染后的 HTML 与 TOC），不存在返回 `null`。 */
export async function getDiaryEntry(slug: string): Promise<DiaryEntry | null> {
  return (await getContentSource()).getDiaryEntry(slug);
}

/* -------------------------------------------------------------------------- */
/* goals                                                                       */
/* -------------------------------------------------------------------------- */

/** 全部目标（按 `order` 升序，正文已渲染）。 */
export async function getAllGoals(): Promise<Goal[]> {
  return (await getContentSource()).getAllGoals();
}
