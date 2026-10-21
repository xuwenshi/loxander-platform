/**
 * goals 分区 schema。
 *
 * 字段来源：apps/web/content/goals/*.md（2 个真实文件）+ desktop schemaService.ts 的 goals 声明。
 *
 * goals 是四类中唯一允许为空的（无 [slug] 详情路由，不走 generateStaticParams）。
 */

import { z } from 'zod';

import { GOAL_HORIZONS, GOAL_STATUSES } from '../kinds';
import { zMilestones, zNonEmpty, zOptionalString, zOrder, zProgress } from '../primitives';

export const goalsSchema = z.object({
  title: zNonEmpty,
  horizon: z.enum(GOAL_HORIZONS, '时间维度必须是 short / mid / long 之一'),
  status: z.enum(GOAL_STATUSES, '状态必须是 planned / active / done / paused 之一'),
  /**
   * 进度 0–100：小数 round、越界报错。
   *
   * 与两侧现状的差异：
   * - 站点（apps/web/src/lib/goals.ts:71-74）是 `Math.round` 后**静默夹取**，
   *   `130` 会变成 `100` 且不报错；
   * - desktop（validateService.ts:112-121）是 clamp + warning，同样不阻断。
   *
   * 按 P1 用户裁决：越界属于填写错误，必须 blocking。
   */
  progress: zProgress,
  period: zOptionalString,
  order: zOrder,
  /**
   * 里程碑：坏项**阻断**（用户裁决）。
   *
   * 站点现状（apps/web/src/lib/goals.ts:76-84）用 `flatMap` **静默丢弃**坏项，
   * 用户以为存了实际丢了。这里改为整表阻断。
   */
  milestones: zMilestones,
});

export type GoalEntry = z.infer<typeof goalsSchema>;
