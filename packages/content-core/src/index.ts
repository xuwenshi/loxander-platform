/**
 * @loxander/content-core 公共导出。
 *
 * 四类内容（blog / diary / projects / goals）的 schema、slug 规则、
 * 发布状态与三段式校验入口。Web 与 Electron 共用，消除双份契约。
 */

// 类型与枚举
export {
  ENTRY_KINDS,
  type EntryKind,
  PROJECT_STATUSES,
  type ProjectStatus,
  GOAL_HORIZONS,
  type GoalHorizon,
  GOAL_STATUSES,
  type GoalStatus,
  SLUG_PATTERN,
  SLUG_MAX_LENGTH,
  DATE_PATTERN,
  MIN_ENTRY_COUNT,
  canBeEmpty,
  isEntryKind,
} from './kinds';

// 基础构件（消费方可能需要单独复用，如表单校验）
export {
  dateToISODate,
  zDate,
  zNonEmpty,
  zOptionalString,
  zStringSet,
  zSlug,
  zOrder,
  zProgress,
  zBooleanFlag,
  zMilestones,
} from './primitives';

// 四类 schema 与推导类型
export { blogSchema, type BlogEntry } from './schemas/blog';
export { diarySchema, type DiaryEntry } from './schemas/diary';
export { projectsSchema, type ProjectEntry } from './schemas/projects';
export { goalsSchema, type GoalEntry } from './schemas/goals';

// 三段式校验入口
export {
  parseEntry,
  isValidSlug,
  ENTRY_SCHEMAS,
  type EntryOf,
  type ParseResult,
  type ParseOptions,
  type ValidationIssue,
} from './parse';
