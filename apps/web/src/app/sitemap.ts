import type { MetadataRoute } from "next";

import {
  getAllDiaryEntries,
  getAllPosts,
  getAllProjects,
} from "@/lib/content";
import { siteConfig } from "@/lib/site";

/** sitemap 覆盖：入口、星图、博客/项目/日记列表与详情、目标、关于、简历 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteConfig.url.replace(/\/$/, "");

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/universe`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/blog`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/projects`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/diary`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/goals`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/about`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/resume`, changeFrequency: "monthly", priority: 0.5 },
  ];

  // P3：内容来源已从文件系统切到 ContentSource（markdown 或 db 由 CONTENT_SOURCE 决定），
  // 所以这里必须 await —— 四个读取函数全部变成异步了。
  const [posts, projects, diaryEntries] = await Promise.all([
    getAllPosts(),
    getAllProjects(),
    getAllDiaryEntries(),
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

  return [...staticRoutes, ...postRoutes, ...projectRoutes, ...diaryRoutes];
}
