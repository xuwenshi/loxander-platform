/**
 * projects 分区 schema。
 *
 * 字段来源：apps/web/content/projects/*.md（3 个真实文件）+ desktop schemaService.ts 的 projects 声明。
 *
 * 注意字段名差异：projects 用 `name`，不是 blog/diary/goals 的 `title`。
 */

import { z } from 'zod';

import { PROJECT_STATUSES } from '../kinds';
import { zBooleanFlag, zNonEmpty, zOptionalString, zOrder, zStringSet } from '../primitives';

export const projectsSchema = z.object({
  /** 项目名。字段名是 `name` 不是 `title`（见 apps/web/src/lib/projects.ts:69）。 */
  name: zNonEmpty,
  description: zNonEmpty,
  techStack: zStringSet,
  status: z.enum(PROJECT_STATUSES, '状态必须是 active / in-progress / completed / archived 之一'),
  period: zOptionalString,
  role: zOptionalString,
  github: zOptionalString,
  demo: zOptionalString,
  /** 关联的 blog slug。引用完整性由 parseEntry 的 warning 层检查。 */
  article: zOptionalString,
  featured: zBooleanFlag,
  order: zOrder,
});

export type ProjectEntry = z.infer<typeof projectsSchema>;
