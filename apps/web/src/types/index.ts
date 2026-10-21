/**
 * 文章 / 项目等内容类型的统一定义，供 lib 与 UI 共同使用。
 *
 * P1 起这里不再是「唯一的真相」：
 * - 能由共享包回答的，一律 re-export，避免站点与桌面端各写一份再慢慢漂移；
 * - 只保留真正属于站点展示层的字段（slug、计算出的阅读时间、渲染产物等）。
 *
 * 对应关系：
 * - `TocItem` → `@loxander/markdown`（TOC 的 id/text/level 由渲染管线决定，必须与正文同源）
 * - `ProjectStatus` / `GoalHorizon` / `GoalStatus` / `GoalMilestone` → `@loxander/content-core`
 *   （共享包的 Zod schema 用它们做枚举校验，类型与运行时取值出自同一处）
 */

import type {
  GoalEntry,
  GoalHorizon,
  GoalStatus,
  ProjectStatus,
} from "@loxander/content-core";
import type { TocItem } from "@loxander/markdown";

/** 文章目录项（由 Markdown 的 h2 / h3 生成） */
export type { TocItem };

/** 枚举取值：active / in-progress / completed / archived */
export {
  PROJECT_STATUSES,
  type ProjectStatus,
  GOAL_HORIZONS,
  type GoalHorizon,
  GOAL_STATUSES,
  type GoalStatus,
} from "@loxander/content-core";

/** 目标里程碑：与 content-core `goalsSchema.milestones` 的元素类型保持一致 */
export type GoalMilestone = GoalEntry["milestones"][number];

/** 文章元信息（frontmatter + 计算字段） */
export type PostMeta = {
  slug: string;
  title: string;
  description: string;
  /** ISO 日期字符串，如 2026-10-08 */
  date: string;
  tags: string[];
  category: string;
  cover?: string;
  /** 封面图原始像素宽度（仅当能从本地 SVG 解析出时才存在） */
  coverWidth?: number;
  /** 封面图原始像素高度（仅当能从本地 SVG 解析出时才存在） */
  coverHeight?: number;
  draft: boolean;
  /** 预计阅读时间（分钟） */
  readingTime: number;
};

/** 文章完整内容 */
export type Post = PostMeta & {
  /** 渲染后的 HTML */
  html: string;
  headings: TocItem[];
};

/** 项目元信息 */
export type ProjectMeta = {
  slug: string;
  name: string;
  description: string;
  techStack: string[];
  status: ProjectStatus;
  /** 项目周期，如 2026.03 - 2026.08 */
  period?: string;
  /** 我在项目中的角色 */
  role?: string;
  github?: string;
  demo?: string;
  /** 关联的文章 slug */
  article?: string;
  featured: boolean;
  order: number;
};

/** 项目完整内容 */
export type Project = ProjectMeta & {
  html: string;
  headings: TocItem[];
};

/** 标签及其文章数量 */
export type TagCount = {
  tag: string;
  count: number;
};

/** 日记元信息（content/diary/*.md） */
export type DiaryMeta = {
  slug: string;
  title: string;
  /** 一句话摘要，显示在时间轴与列表里 */
  summary: string;
  /** ISO 日期字符串，如 2026-10-10 */
  date: string;
  /** 可选的心情标签，例如「平静」 */
  mood?: string;
  tags: string[];
  draft: boolean;
};

/** 日记完整内容 */
export type DiaryEntry = DiaryMeta & {
  html: string;
  headings: TocItem[];
};

/**
 * 目标（content/goals/*.md）。
 *
 * 注意 `progress`：内容里默认是 `0`，代表「尚未开始 / 还没填」，
 * 不表示任何真实完成度 —— 请自行填写真实进度。
 */
export type Goal = {
  slug: string;
  title: string;
  horizon: GoalHorizon;
  status: GoalStatus;
  /** 0-100 的整数 */
  progress: number;
  /** 时间范围，如 2026 Q4 */
  period?: string;
  order: number;
  milestones: GoalMilestone[];
  html: string;
  headings: TocItem[];
};
