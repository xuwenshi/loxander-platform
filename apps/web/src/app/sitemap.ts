import type { MetadataRoute } from "next";

import {
  getAllDiaryEntries,
  getAllPosts,
  getAllProjects,
  getAllTags,
} from "@/lib/content";
import { siteConfig } from "@/lib/site";
import { mergeTagsByUrl, tagHref } from "@/lib/tag-url";

/** sitemap 覆盖：入口、星图、博客/项目/日记列表与详情、目标、关于、简历、标签页 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteConfig.url.replace(/\/$/, "");

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/universe`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/blog`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/projects`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/diary`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/goals`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/tags`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/about`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/resume`, changeFrequency: "monthly", priority: 0.5 },
  ];

  // P3：内容来源已从文件系统切到 ContentSource（markdown 或 db 由 CONTENT_SOURCE 决定），
  // 所以这里必须 await —— 四个读取函数全部变成异步了。
  const [posts, projects, diaryEntries, tags] = await Promise.all([
    getAllPosts(),
    getAllProjects(),
    getAllDiaryEntries(),
    getAllTags(),
  ]);

  const postRoutes: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${base}/blog/${post.slug}`,
    lastModified: post.date,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const projectRoutes: MetadataRoute.Sitemap = projects.map((project) => ({
    url: `${base}/projects/${project.slug}`,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  const diaryRoutes: MetadataRoute.Sitemap = diaryEntries.map((entry) => ({
    url: `${base}/diary/${entry.slug}`,
    lastModified: entry.date,
    changeFrequency: "monthly",
    priority: 0.4,
  }));

  /*
    P5：标签页也要进 sitemap。
    标签页是稳定的长尾入口（用户会从搜索引擎直接落到 `/tags/rag`），
    不收录等于白做。`tagHref()` 返回的已经是以 `/` 开头的相对路径，
    拼 base 即可 —— 不要在这里再自己 `toLowerCase()`，那是第三套归一化。

    `mergeTagsByUrl()` 是必须的：`getAllTags()` 按原字符串计数，若库里同时有
    `"RAG"` 与 `"rag"`，这里会产出两条**完全相同**的 URL —— sitemap 里出现重复
    地址会被搜索引擎判为质量信号问题。合并后每个 URL 只出现一次。

    `/search` **刻意不进 sitemap**：搜索结果页的每条 query 都是独立 URL，
    收录它们会让爬虫对着无限组合空转（同 `robots: { index: false }` 的理由）。
  */
  const tagRoutes: MetadataRoute.Sitemap = mergeTagsByUrl(tags).map(({ tag }) => ({
    url: `${base}${tagHref(tag)}`,
    changeFrequency: "weekly",
    priority: 0.5,
  }));

  return [
    ...staticRoutes,
    ...postRoutes,
    ...projectRoutes,
    ...diaryRoutes,
    ...tagRoutes,
  ];
}
