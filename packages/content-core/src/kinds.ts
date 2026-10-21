/**
 * 内容类型与状态枚举。
 *
 * 契约来源（按 P1 决策「以 desktop FieldSpec + 真实内容为准」）：
 * - `apps/desktop/src/main/services/schemaService.ts` 的 CONTENT_SECTIONS 与 options
 * - `apps/web/content/` 下 10 个真实 Markdown 文件
 *
 * 与旧实现的差异见 docs/recon-p0.md §2.5。
 */

/** 四类内容分区。名称即 content/<kind>/ 目录名，也是 URL 段（goals 除外）。 */
export const ENTRY_KINDS = ['blog', 'diary', 'projects', 'goals'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** 项目状态。顺序与 desktop schemaService.ts 的 options 一致。 */
export const PROJECT_STATUSES = ['active', 'in-progress', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** 目标时间维度。 */
export const GOAL_HORIZONS = ['short', 'mid', 'long'] as const;
export type GoalHorizon = (typeof GOAL_HORIZONS)[number];

/** 目标状态。 */
export const GOAL_STATUSES = ['planned', 'active', 'done', 'paused'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * slug 规则：采纳 desktop `pathGuard.ts` 的 SAFE_SLUG。
 *
 * 为什么比站点现状严：站点侧（apps/web/src/lib/*.ts）直接用
 * `file.replace(/\.md$/, "")` 当 slug，没有任何校验；desktop 有校验。
 * 按 P1 决策以更严的一侧为准，且实测 10 个真实 slug 全部通过，零误伤。
 */
export const SLUG_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const SLUG_MAX_LENGTH = 200;

/** 日期格式：严格 YYYY-MM-DD，两端锚定。 */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 各分区是否禁止删空。
 *
 * Next 16 在 Cache Components 模式下 `generateStaticParams` 不接受空数组，
 * 因此 blog / diary / projects（有 [slug] 详情路由）至少保留 1 篇。
 * goals 没有详情路由，允许为空。
 *
 * 来源：apps/desktop/src/main/services/schemaService.ts 的 minCount 字段。
 */
export const MIN_ENTRY_COUNT: Record<EntryKind, number> = {
  blog: 1,
  diary: 1,
  projects: 1,
  goals: 0,
};

/** 判断某分区是否允许删空。 */
export function canBeEmpty(kind: EntryKind): boolean {
  return MIN_ENTRY_COUNT[kind] === 0;
}

export function isEntryKind(value: unknown): value is EntryKind {
  return typeof value === 'string' && (ENTRY_KINDS as readonly string[]).includes(value);
}
