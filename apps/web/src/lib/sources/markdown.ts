/**
 * `ContentSource` 的 markdown 实现：**纯粹转调**现有的四个 lib。
 *
 * 存在的意义不是「再加一层」，而是让 P3 的页面迁移有确切的可比对目标：
 * 这个实现必须与直接调用 `lib/posts.ts` 等**逐字节等价**，
 * 因此它不做任何额外加工 —— 不排序、不过滤、不重算，参数原样进、结果原样出。
 *
 * 只有一处形态差异：现有 lib 里 12 个函数是同步的，这里统一包成 `Promise`
 * （原因见 `lib/content-source.ts` 文件头）。
 */

import "server-only";

import type { ContentSource } from "../content-source";
import { getAllDiaryEntries, getDiaryEntry, getDiarySlugs } from "../diary";
import { getAllGoals } from "../goals";
import {
  getAdjacentPosts,
  getAllCategories,
  getAllPosts,
  getAllTags,
  getBlogSlugs,
  getPost,
  getPostsByTag,
  getRecentPosts,
  getRelatedPosts,
  getSearchDocs,
} from "../posts";
import { getAllProjects, getFeaturedProjects, getProject } from "../projects";
import { searchDocs } from "../search";

/**
 * 创建 markdown 内容源。
 *
 * 每个方法都只有一行 `return`，是有意为之：
 * 这里一旦出现任何逻辑，就会成为「站点行为」与「DB 行为」之外的**第三个实现**，
 * 三方比对（数量 / slug / 渲染快照）立刻失去意义。
 */
export function createMarkdownContentSource(): ContentSource {
  return {
    kind: "markdown",

    /* ------------------------------ blog ------------------------------ */

    // 注意：getBlogSlugs **不**过滤草稿（posts.ts:39-41 直接列文件名）。
    async getBlogSlugs() {
      return getBlogSlugs();
    },

    async getAllPosts() {
      return getAllPosts();
    },

    async getRecentPosts(limit = 3) {
      return getRecentPosts(limit);
    },

    async getPost(slug: string) {
      return getPost(slug);
    },

    async getAdjacentPosts(slug: string) {
      return getAdjacentPosts(slug);
    },

    async getRelatedPosts(slug: string, limit = 3) {
      return getRelatedPosts(slug, limit);
    },

    async getAllTags() {
      return getAllTags();
    },

    async getAllCategories() {
      return getAllCategories();
    },

    /* ------------------- P5：标签页与服务端搜索 ------------------- */

    // 归一化与匹配规则在 lib/tag-url.ts，这里只转调，不写第二套。
    async getPostsByTag(tag: string) {
      return getPostsByTag(tag);
    },

    // 打分与排序在 lib/search.ts：这里提供候选（含正文原文），不自己实现匹配。
    async searchPosts(query: string) {
      return searchDocs(getSearchDocs(), query);
    },

    /* ---------------------------- projects ---------------------------- */

    async getAllProjects() {
      return getAllProjects();
    },

    async getFeaturedProjects(limit = 3) {
      return getFeaturedProjects(limit);
    },

    async getProject(slug: string) {
      return getProject(slug);
    },

    /* ----------------------------- diary ------------------------------ */

    async getAllDiaryEntries() {
      return getAllDiaryEntries();
    },

    // 与 diary.ts:79-81 一致：草稿过滤在 getAllDiaryEntries 内部完成。
    async getDiarySlugs() {
      return getDiarySlugs();
    },

    async getDiaryEntry(slug: string) {
      return getDiaryEntry(slug);
    },

    /* ----------------------------- goals ------------------------------ */

    async getAllGoals() {
      return getAllGoals();
    },
  };
}
