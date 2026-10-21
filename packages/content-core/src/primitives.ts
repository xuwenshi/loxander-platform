/**
 * Zod 基础构件。
 *
 * 每个构件都对应一处「真实数据会踩到、但朴素写法会出错」的坑，
 * 注释里记录了实测结论，改动前请先读。
 */

import { z } from 'zod';

import { DATE_PATTERN, SLUG_MAX_LENGTH, SLUG_PATTERN } from './kinds';

/* -------------------------------------------------------------------------- */
/* 日期                                                                        */
/* -------------------------------------------------------------------------- */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 把 Date 归一成 YYYY-MM-DD。
 *
 * 为什么要双分支（实测，本机 UTC+8）：
 * - YAML 裸日期 `date: 2026-08-26` 被 gray-matter 解析成 **UTC 午夜**的 Date，
 *   此时 `toISOString().slice(0, 10)` 得到正确日期。
 * - 但本地构造的 Date（如日期选择器、`new Date(2026, 7, 26)`）在 UTC+8 下
 *   `toISOString()` 会**退一天**（得到 2026-08-25）。
 *
 * 因此：UTC 午夜走 toISOString，其余走本地分量。
 * 这条修正了 desktop `frontmatterService.ts` 原注释「一律取 UTC 前 10 位避免差一天」的错误说法
 * —— 那个说法只对 YAML 裸日期成立。
 */
export function dateToISODate(value: Date): string {
  const isUtcMidnight =
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0;

  if (isUtcMidnight) return value.toISOString().slice(0, 10);

  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

/**
 * 日期字段。
 *
 * 真实输入可能是三种形态（gray-matter 行为实测）：
 * - `Date` 对象（YAML 裸日期 `2026-08-26`）→ 归一成字符串
 * - 字符串（带引号的 `"2026-08-26"`）→ trim 后校验
 * - 其它（null / 数字 / `2026/01/01` / `2026-10-12xyz`）→ 失败
 *
 * 注意必须用 preprocess：直接 `z.string().regex()` 会把 Date 输入判失败。
 */
export const zDate = z.preprocess(
  (v) => (v instanceof Date ? dateToISODate(v) : typeof v === 'string' ? v.trim() : v),
  z.string().regex(DATE_PATTERN, '日期必须是 YYYY-MM-DD 格式'),
);

/* -------------------------------------------------------------------------- */
/* 字符串                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 非空字符串：先 trim 再判空。
 *
 * 对齐 desktop `validateService.isNonEmptyString`（`trim().length > 0`），
 * 也覆盖站点侧 `requireString` 的行为。
 */
export const zNonEmpty = z.string().trim().min(1, '不能为空');

/** 可选字符串：空串 / 纯空白视为「未提供」，归一为 undefined。 */
export const zOptionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v),
  z.string().min(1).optional(),
);

/* -------------------------------------------------------------------------- */
/* 字符串数组                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 标签 / 技术栈数组：trim + 去重 + 丢弃空串。
 *
 * 这是 P1 **新增**的行为，两侧现状都没做：
 * - 站点 `toStringArray` 只过滤非字符串，不去重、不 trim
 * - desktop 同样不去重
 *
 * 后果是 tag 云会重复计数（`["RAG", "RAG"]` 让 RAG 计 2 次）。
 * 实测真实 10 个文件无重复、无空白，因此加上此约束零误伤。
 */
export const zStringSet = z
  .array(z.string())
  .transform((items) => {
    const seen = new Set<string>();
    for (const item of items) {
      const trimmed = item.trim();
      if (trimmed !== '') seen.add(trimmed);
    }
    return [...seen];
  })
  .default([]);

/* -------------------------------------------------------------------------- */
/* slug                                                                        */
/* -------------------------------------------------------------------------- */

/** slug：采纳 desktop SAFE_SLUG，并排除 `.` 与 `..`（路径穿越形态）。 */
export const zSlug = z
  .string()
  .min(1, 'slug 不能为空')
  .max(SLUG_MAX_LENGTH, `slug 不能超过 ${SLUG_MAX_LENGTH} 字符`)
  .regex(SLUG_PATTERN, 'slug 仅允许字母、数字、点、下划线、连字符')
  .refine((s) => s !== '.' && s !== '..', 'slug 不能是 . 或 ..');

/* -------------------------------------------------------------------------- */
/* 数值                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 排序字段：缺省 999。
 *
 * ⚠️ 必须用 preprocess 兜住空值。实测 `z.coerce.number().int().default(999)`：
 * - `undefined` → 999 ✅
 * - `""`       → **0** ❌（应 999）
 * - `null`     → **0** ❌（应 999）
 *
 * 原因是 `coerce` 先把 `""` 变成 `Number("") === 0`，`default` 只处理 undefined，
 * 于是空值悄悄变成 0，排序跑到最前面。因此先把空值转成 undefined。
 *
 * 与站点现状的差异：站点写的是 `typeof value === "number" ? value : 999`，
 * 字符串 `"1"` 会退化成 999；这里用 coerce 强转成 1（采纳 desktop 的 Number() 语义）。
 */
export const zOrder = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'string' && v.trim() === '') return undefined;
    return v;
  },
  z.coerce.number().int('排序必须是整数').default(999),
);

/**
 * 进度 0–100。
 *
 * 用户裁决（P1）：**小数 round，越界报错**。
 * - `50.6` → `51`（格式归一，不报错）
 * - `130`  → blocking（用户填错，不能静默夹取成 100）
 * - `-5`   → blocking
 *
 * 为什么不静默夹取：desktop 原实现是 clamp + warning，但静默夹取会让用户
 * 以为「130% 已被记录」，实际是 100%。越界属于填写错误，必须让用户看见。
 */
export const zProgress = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
  z.coerce
    .number()
    .default(0)
    .transform((n) => Math.round(n))
    .pipe(z.number().min(0, '进度不能小于 0').max(100, '进度不能大于 100')),
);

/* -------------------------------------------------------------------------- */
/* 布尔                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 布尔字段，缺省 false。
 *
 * 与站点现状的差异：站点写 `frontmatter.draft === true`，字符串 `"true"`
 * 会被静默当成 false。这里要求真正的布尔值，避免「看着是 true 实际是 false」。
 */
export const zBooleanFlag = z.boolean().default(false);

/** 里程碑：坏项**阻断**（用户裁决），不静默丢弃。 */
export const zMilestones = z
  .array(
    z.object({
      title: zNonEmpty,
      done: z.boolean(),
    }),
  )
  .default([]);
