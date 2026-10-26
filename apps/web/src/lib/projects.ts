import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { extractHeadings, renderMarkdown } from "@loxander/markdown";

import { getBlogSlugs } from "./posts";
import { parseOrThrow } from "./parse-entry";
import { contentDir } from "./app-root";
import type { Project, ProjectMeta } from "@/types";

/**
 * 项目内容读取（content/projects/*.md）。
 *
 * P1 起 frontmatter 校验交给 `@loxander/content-core`，
 * Markdown 渲染交给 `@loxander/markdown` —— 与站点、桌面端同一份实现。
 */

/** 见 `lib/app-root.ts`：不能用 `process.cwd()`，生产启动时它是仓库根。 */
const PROJECTS_DIR = contentDir("projects");

function listProjectFiles(): string[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort();
}

type ParsedProject = {
  meta: ProjectMeta;
  body: string;
};

function parseProjectFile(file: string): ParsedProject {
  const slug = file.replace(/\.md$/, "");
  const raw = fs.readFileSync(path.join(PROJECTS_DIR, file), "utf8");
  const { data, content } = matter(raw);

  // `article` 指向不存在的 blog slug 只产生 warning（页面仍可构建），
  // 因此这里把已知 slug 列表传进去，由 content-core 决定怎么提示。
  const entry = parseOrThrow("projects", data, file, {
    knownBlogSlugs: getBlogSlugs(),
  });

  const meta: ProjectMeta = {
    slug,
    name: entry.name,
    description: entry.description,
    techStack: entry.techStack,
    status: entry.status,
    period: entry.period,
    role: entry.role,
    github: entry.github,
    demo: entry.demo,
    article: entry.article,
    featured: entry.featured,
    order: entry.order,
  };

  return { meta, body: content };
}

function readAllParsedProjects(): ParsedProject[] {
  return listProjectFiles()
    .map(parseProjectFile)
    .sort((a, b) => a.meta.order - b.meta.order || a.meta.name.localeCompare(b.meta.name));
}

/** 全部项目元信息 */
export function getAllProjects(): ProjectMeta[] {
  return readAllParsedProjects().map((project) => project.meta);
}

/** 首页展示的精选项目 */
export function getFeaturedProjects(limit = 3): ProjectMeta[] {
  const projects = getAllProjects();
  const featured = projects.filter((project) => project.featured);
  return (featured.length > 0 ? featured : projects).slice(0, limit);
}

/**
 * 单个项目（含渲染后的 HTML 与目录）。
 * 与 getPost 同理：按 slug 缓存重计算，并隔离 Shiki 内部对 `Date.now()` 的读取。
 */
export async function getProject(slug: string): Promise<Project | null> {
  "use cache";

  const parsed = readAllParsedProjects().find((project) => project.meta.slug === slug);
  if (!parsed) return null;

  const [html, headings] = await Promise.all([
    renderMarkdown(parsed.body),
    Promise.resolve(extractHeadings(parsed.body)),
  ]);

  return { ...parsed.meta, html, headings };
}
