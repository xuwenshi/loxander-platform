/**
 * 后台表单的校验层（**不是** Server Action，不能加 `"use server"`）。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────
 * `"use server"` 文件里的每个导出都必须是 async 函数，而这里全是纯函数
 * （同步校验、纯转换）。混在一起会让 Next 在构建期报
 * 「Server Actions must be async functions」。
 *
 * ── 为什么复用 `parseEntry` 而不是另写一套 Zod ────────────────────────
 * 内容有**两个入口**：P2 的 Markdown 导入器、P4 的后台表单。
 * 两边各写一套校验，迟早会出现「导入能过、后台不能存」或者反过来的漂移。
 * 所以这里把表单字段拼成 frontmatter 形状，直接交给 `@loxander/content-core`
 * 的 `parseEntry` —— 与导入器用的是**同一个 schema**，规则天然一致。
 *
 * 代价：表单必须提供 frontmatter 需要的全部必填字段（blog/diary 要 `date`，
 * projects 要 `name` 而不是 `title`）。这不是负担，而是把「数据库里的行
 * 必须能还原成一份合法 frontmatter」这条不变量显式化了 —— 否则
 * 「后台改完的内容导出回 markdown」这条路立刻断掉。
 */

import {
  ENTRY_KINDS,
  GOAL_HORIZONS,
  GOAL_STATUSES,
  PROJECT_STATUSES,
  isValidSlug,
  parseEntry,
  type EntryKind,
  type EntryOf,
  type ValidationIssue,
} from "@loxander/content-core";
import { z } from "zod";

/** 表单里与内容类型无关的公共字段。 */
export const entryFormBaseSchema = z.object({
  kind: z.enum(["blog", "diary", "projects", "goals"]),
  slug: z.string().trim().min(1, "slug 不能为空").max(200, "slug 最长 200 字符"),
  // 用 refine 而不是 `.trim().min(1)`：`.trim()` 会改动正文首尾空白（Markdown 里
  // 前导空格有意义），但纯空白正文必须拦下 —— 否则能存进一条渲染出空 `body_html`
  // 的草稿，只有等发布时才被 `transitionStatus` 的 `body_md.trim()` 拦住。
  bodyMd: z
    .string()
    .refine((value) => value.trim().length > 0, { message: "正文不能为空" }),
  /** 逗号 / 换行分隔的标签原文，由 `normalizeTagInput` 归一化。 */
  tags: z.string().default(""),
  /** 乐观锁：客户端提交它读到的 version，服务端比对。 */
  expectedVersion: z.coerce.number().int().min(1, "版本号必须是正整数"),
  changeNote: z.string().trim().max(200, "变更说明最长 200 字符").optional(),
});

export type EntryFormBase = z.infer<typeof entryFormBaseSchema>;

/** 校验失败时的返回形状：字段名 → 人类可读的错误。 */
export type FieldErrors = Record<string, string>;

export interface FormValidationSuccess {
  ok: true;
  base: EntryFormBase;
  /** 归一化后的标签（顺序即 `tag_order`）。 */
  tags: string[];
  /** 按 kind 收窄后的内容字段。 */
  entry: EntryOf<EntryKind>;
  /** 该 kind 的 `entries.data` 形状（与 `db/schema.ts` 末尾四个 interface 对应）。 */
  data: Record<string, unknown>;
  /** 从 entry 提升到列上的值。 */
  title: string;
  summary: string;
  featured: boolean;
  sortOrder: number;
  /** blog/diary 的展示日期（`YYYY-MM-DD`）；projects/goals 为 null。 */
  displayDate: string | null;
  /** `draft=true` 时调用方应存为草稿。 */
  isDraft: boolean;
}

export interface FormValidationFailure {
  ok: false;
  fieldErrors: FieldErrors;
  /** 全量问题清单，便于在页面上一次性列出来。 */
  issues: ValidationIssue[];
}

export type FormValidationResult = FormValidationSuccess | FormValidationFailure;

/**
 * 标签输入归一化：逗号（中英文）、换行、顿号都当分隔符。
 *
 * **顺序必须保留**（去重保序）—— 数组下标直接就是 `entry_tags.tag_order`，
 * 用 `Set` 去重本身保序，但必须**先 trim 再判空**，否则 `"a, ,b"` 会留下空槽。
 *
 * 这条规则与 `packages/content-core/src/primitives.ts` 的 `zStringSet`
 * 完全一致；这里手工做是因为表单里标签是**一个字符串输入框**，
 * 而 frontmatter 里是数组。
 */
export function normalizeTagInput(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const piece of raw.split(/[,，\n、]+/)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** 读 FormData 里的字符串字段（缺省为空串，不是 undefined）。 */
export function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** 读 FormData 里的复选框（浏览器只在勾选时提交，值通常是 "on"）。 */
export function readCheckbox(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
}

/**
 * 把 `ValidationIssue` 摊平成字段错误。
 *
 * 一个字段可能有多条问题（比如 `tags` 里有两个非法项），
 * 用 `；` 连接而不是只留第一条 —— 否则用户改完第一个又冒出来第二个。
 */
function toFieldErrors(issues: readonly ValidationIssue[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.field ?? "_form";
    errors[key] = errors[key] ? `${errors[key]}；${issue.message}` : issue.message;
  }
  return errors;
}

/**
 * 按 kind 把 FormData 拼成 frontmatter 形状。
 *
 * 每一步都刻意「宽松地读、严格地交给 parseEntry」：
 * 这里不做类型判断，只做拼装；判断权在共享 schema 手里。
 */
function buildFrontmatter(kind: EntryKind, form: FormData): Record<string, unknown> {
  const draft = readCheckbox(form, "draft");

  switch (kind) {
    case "blog":
      return {
        title: readField(form, "title"),
        description: readField(form, "summary"),
        date: readField(form, "displayDate"),
        category: readField(form, "category"),
        // 空字符串交给 zStringSet 处理（会变成 []）；有值就按数组传，
        // 让共享 schema 里的 trim/去重逻辑生效，而不是这里先做一遍。
        tags: normalizeTagInput(readField(form, "tags")),
        cover: readField(form, "cover"),
        draft,
      };

    case "diary":
      return {
        title: readField(form, "title"),
        summary: readField(form, "summary"),
        date: readField(form, "displayDate"),
        mood: readField(form, "mood"),
        tags: normalizeTagInput(readField(form, "tags")),
        draft,
      };

    case "projects":
      return {
        name: readField(form, "title"),
        description: readField(form, "summary"),
        techStack: normalizeTagInput(readField(form, "techStack")),
        status: readField(form, "status") || "in-progress",
        period: readField(form, "period"),
        role: readField(form, "role"),
        github: readField(form, "github"),
        demo: readField(form, "demo"),
        article: readField(form, "article"),
        featured: readCheckbox(form, "featured"),
        order: readField(form, "sortOrder"),
      };

    case "goals":
      return {
        title: readField(form, "title"),
        horizon: readField(form, "horizon") || "short",
        status: readField(form, "status") || "planned",
        progress: readField(form, "progress"),
        period: readField(form, "period"),
        order: readField(form, "sortOrder"),
        // 里程碑用两个并行数组提交（milestone-title / milestone-done），
        // 按下标配对。这样前端不需要序列化 JSON，也保留了顺序。
        milestones: readMilestones(form),
      };
  }
}

/** 读取里程碑：两个并行数组按下标配对，标题为空的项丢弃。 */
function readMilestones(form: FormData): { title: string; done: boolean }[] {
  const titles = form.getAll("milestoneTitle").map((value) => String(value));
  const dones = form.getAll("milestoneDone").map((value) => String(value));
  const result: { title: string; done: boolean }[] = [];

  for (let index = 0; index < titles.length; index += 1) {
    const title = titles[index].trim();
    if (!title) continue;
    result.push({ title, done: dones[index] === "on" || dones[index] === "true" });
  }

  return result;
}

/** 把 kind 的 `data` 从收窄后的 entry 里搬出来（与 `db/schema.ts` 的 interface 对齐）。 */
function buildData(kind: EntryKind, entry: EntryOf<EntryKind>): Record<string, unknown> {
  switch (kind) {
    case "blog": {
      const blog = entry as EntryOf<"blog">;
      const data: Record<string, unknown> = { category: blog.category };
      if (blog.cover) data.cover = blog.cover;
      // coverWidth / coverHeight 由导入器从 SVG 读出来；后台不重算，
      // 交给调用方在保存时保留旧值（见 actions.ts 的 mergeCoverDimensions）。
      return data;
    }
    case "diary": {
      const diary = entry as EntryOf<"diary">;
      const data: Record<string, unknown> = {};
      if (diary.mood) data.mood = diary.mood;
      return data;
    }
    case "projects": {
      const project = entry as EntryOf<"projects">;
      const data: Record<string, unknown> = {
        techStack: project.techStack,
        status: project.status,
      };
      if (project.period) data.period = project.period;
      if (project.role) data.role = project.role;
      if (project.github) data.github = project.github;
      if (project.demo) data.demo = project.demo;
      if (project.article) data.article = project.article;
      return data;
    }
    case "goals": {
      const goal = entry as EntryOf<"goals">;
      const data: Record<string, unknown> = {
        horizon: goal.horizon,
        status: goal.status,
        progress: goal.progress,
        milestones: goal.milestones,
      };
      if (goal.period) data.period = goal.period;
      return data;
    }
  }
}

/** 从 entry 里取「提升到 entries 列上」的那几个值。 */
function buildColumns(
  kind: EntryKind,
  entry: EntryOf<EntryKind>,
): { title: string; summary: string; featured: boolean; sortOrder: number; displayDate: string | null } {
  switch (kind) {
    case "blog": {
      const blog = entry as EntryOf<"blog">;
      return {
        title: blog.title,
        summary: blog.description,
        featured: false,
        sortOrder: 999,
        displayDate: blog.date,
      };
    }
    case "diary": {
      const diary = entry as EntryOf<"diary">;
      return {
        title: diary.title,
        summary: diary.summary,
        featured: false,
        sortOrder: 999,
        displayDate: diary.date,
      };
    }
    case "projects": {
      const project = entry as EntryOf<"projects">;
      return {
        title: project.name,
        summary: project.description,
        featured: project.featured,
        sortOrder: project.order,
        displayDate: null,
      };
    }
    case "goals": {
      const goal = entry as EntryOf<"goals">;
      return {
        title: goal.title,
        // goals 没有摘要字段，列 notNull 且默认 ''。
        summary: "",
        featured: false,
        sortOrder: goal.order,
        displayDate: null,
      };
    }
  }
}

/**
 * 第 3、4 道关：参数校验 + 字段权限校验。
 *
 * 「字段权限」在这里的含义是：**该 kind 不该有的字段一律不接受**。
 * 拼 frontmatter 时只读该 kind 需要的键，其余表单字段根本不会进入
 * `buildFrontmatter`，所以 `projects` 表单里塞一个 `category` 也不会被写进库。
 */
export function validateEntryForm(form: FormData): FormValidationResult {
  const rawKind = readField(form, "kind");
  if (!(ENTRY_KINDS as readonly string[]).includes(rawKind)) {
    return {
      ok: false,
      fieldErrors: { kind: `未知内容类型：${rawKind || "(空)"}` },
      issues: [
        {
          level: "block",
          field: "kind",
          message: `未知内容类型：${rawKind || "(空)"}`,
          hint: `允许值：${ENTRY_KINDS.join(" / ")}`,
        },
      ],
    };
  }

  const kind = rawKind as EntryKind;

  const baseParsed = entryFormBaseSchema.safeParse({
    kind,
    slug: readField(form, "slug"),
    bodyMd: readField(form, "bodyMd"),
    tags: readField(form, "tags"),
    expectedVersion: readField(form, "expectedVersion"),
    changeNote: readField(form, "changeNote") || undefined,
  });

  if (!baseParsed.success) {
    const issues: ValidationIssue[] = baseParsed.error.issues.map((issue) => ({
      level: "block" as const,
      field: issue.path.join(".") || "_form",
      message: issue.message,
    }));
    // slug 的字符集规则不在 Zod 里（content-core 用独立的 `isValidSlug`），补在这里。
    return { ok: false, fieldErrors: toFieldErrors(issues), issues };
  }

  const base = baseParsed.data;

  if (!isValidSlug(base.slug)) {
    const issue: ValidationIssue = {
      level: "block",
      field: "slug",
      message: `非法 slug：${base.slug}`,
      hint: "仅允许字母、数字、点、下划线、连字符，且不能是 . 或 ..",
    };
    return { ok: false, fieldErrors: toFieldErrors([issue]), issues: [issue] };
  }

  const frontmatter = buildFrontmatter(kind, form);
  const parsed = parseEntry(kind, frontmatter);

  if (!parsed.data) {
    const blocking = parsed.blocking.length > 0
      ? parsed.blocking
      : [{ level: "block" as const, message: "内容校验失败（未返回具体原因）" }];
    return { ok: false, fieldErrors: toFieldErrors(blocking), issues: blocking };
  }

  const entry = parsed.data as EntryOf<EntryKind>;
  const columns = buildColumns(kind, entry);

  return {
    ok: true,
    base,
    tags: normalizeTagInput(base.tags),
    entry,
    data: buildData(kind, entry),
    title: columns.title,
    summary: columns.summary,
    featured: columns.featured,
    sortOrder: columns.sortOrder,
    displayDate: columns.displayDate,
    isDraft: (frontmatter.draft as boolean | undefined) === true,
  };
}

/* -------------------------------------------------------------------------- */
/* 状态流转                                                                    */
/* -------------------------------------------------------------------------- */

/** 后台允许的状态集合 —— 与 `db/schema.ts` 的 `PUBLISH_STATUSES` 同源语义。 */
export const ADMIN_STATUSES = ["draft", "scheduled", "published", "archived"] as const;
export type AdminStatus = (typeof ADMIN_STATUSES)[number];

export const STATUS_LABELS: Record<AdminStatus, string> = {
  draft: "草稿",
  scheduled: "定时",
  published: "已发布",
  archived: "已归档",
};

export const KIND_LABELS: Record<EntryKind, string> = {
  blog: "文章",
  diary: "日记",
  projects: "项目",
  goals: "目标",
};

/** 校验状态值（来自 FormData，必须当成不可信输入）。 */
export function parseAdminStatus(value: string): AdminStatus | null {
  return (ADMIN_STATUSES as readonly string[]).includes(value)
    ? (value as AdminStatus)
    : null;
}

/**
 * 定时发布时间的校验。
 *
 * 只接受 `datetime-local` 的值（`YYYY-MM-DDTHH:mm`）。刻意不猜时区：
 * 浏览器给的是**本地时间字面量**，`new Date("2026-01-01T09:00")` 会按
 * 运行环境的本地时区解析 —— 服务端在 Vercel 上是 UTC，那样存进去会差 8 小时。
 * 所以前端必须把一个带偏移的 ISO 串提交上来，服务端只做 `Date.parse` 校验。
 * 这是刻意的「拒绝模糊输入」：猜时区猜错一次，内容就会在错误的时刻上线。
 */
export function parseScheduledAt(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

/** 把 frontmatter 的枚举值暴露给表单渲染（避免页面里重复写字面量数组）。 */
export const FORM_ENUMS = {
  projectStatuses: PROJECT_STATUSES,
  goalHorizons: GOAL_HORIZONS,
  goalStatuses: GOAL_STATUSES,
} as const;
