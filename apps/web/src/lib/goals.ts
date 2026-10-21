import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { extractHeadings, renderMarkdown } from "@loxander/markdown";

import { parseOrThrow } from "./parse-entry";
import type { Goal, GoalMilestone } from "@/types";

/**
 * 目标内容读取（content/goals/*.md）。
 *
 * `progress` 只来自 frontmatter，不做任何推断 —— 仓库内的占位内容全部是 `0`，
 * 表示「还没有填写真实进度」，不是「已完成 0%」的暗示。
 *
 * P1 起 frontmatter 校验交给 `@loxander/content-core`，三处行为与旧实现不同
 * （均为用户裁决过的收紧，见 docs/adr 与 packages/content-core 注释）：
 * - `progress: 130` 旧实现静默夹取成 100，现在**报错**（让填写错误可见）；
 *   `progress: 50.6` 仍会 round 成 51，不报错。
 * - `milestones` 里的坏项旧实现用 `flatMap` **静默丢弃**，现在**整条报错**。
 * - `order` 旧实现要求 `typeof === "number"`（字符串 `"1"` 退化成 999），
 *   现在按 desktop 的 `Number()` 语义强转。
 */

const GOALS_DIR = path.join(process.cwd(), "content", "goals");

function listGoalFiles(): string[] {
  if (!fs.existsSync(GOALS_DIR)) return [];
  return fs
    .readdirSync(GOALS_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort();
}

type ParsedGoal = {
  meta: Omit<Goal, "html" | "headings">;
  body: string;
};

function parseGoalFile(file: string): ParsedGoal {
  const slug = file.replace(/\.md$/, "");
  const raw = fs.readFileSync(path.join(GOALS_DIR, file), "utf8");
  const { data, content } = matter(raw);

  const entry = parseOrThrow("goals", data, file);

  const milestones: GoalMilestone[] = entry.milestones.map((milestone) => ({
    title: milestone.title,
    done: milestone.done,
  }));

  const meta = {
    slug,
    title: entry.title,
    horizon: entry.horizon,
    status: entry.status,
    progress: entry.progress,
    period: entry.period,
    order: entry.order,
    milestones,
  };

  return { meta, body: content };
}

function readAllParsedGoals(): ParsedGoal[] {
  return listGoalFiles()
    .map(parseGoalFile)
    .sort((a, b) => a.meta.order - b.meta.order || a.meta.title.localeCompare(b.meta.title));
}

/**
 * 全部目标（按 order 升序，含渲染后的 HTML）。
 *
 * 目标数量少、正文短，所以列表页直接一次性渲染完 —— 页面不需要 JS 就能展开阅读。
 * 与文章/项目/日记列表同理，必须走 `"use cache"` 隔离 Shiki 内部对 `Date.now()` 的读取。
 */
export async function getAllGoals(): Promise<Goal[]> {
  "use cache";

  const parsed = readAllParsedGoals();

  return Promise.all(
    parsed.map(async ({ meta, body }) => ({
      ...meta,
      // 正文嵌在卡片里（分组 h2 → 卡片标题 h3），Markdown 标题要降到卡片标题之下，
      // 所以整体下移两级：正文里的 ## 变成 h4，### 变成 h5。
      html: await renderMarkdown(body, { headingOffset: 2 }),
      headings: extractHeadings(body),
    })),
  );
}
