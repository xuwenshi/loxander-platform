/**
 * 三段式校验入口。
 *
 * 为什么不用纯 Zod `safeParse`：
 * Zod 只有「通过 / 失败」二元结果，表达不了 desktop `ValidationResult` 的
 * `warnings`（通过但有提示）。而 `entryService` / `preflightService` 依赖 warnings 计数，
 * 且「cover 文件不存在」「article 指向无效 slug」这类问题**不应该阻断保存**。
 *
 * 因此：Zod 负责 blocking 判定，本文件在外层补 warning 逻辑。
 */

import type { z } from 'zod';

import { isEntryKind, type EntryKind } from './kinds';
import { blogSchema } from './schemas/blog';
import { diarySchema } from './schemas/diary';
import { goalsSchema } from './schemas/goals';
import { projectsSchema } from './schemas/projects';

/** 一条校验问题。字段路径用点号连接，如 `milestones.0.title`。 */
export interface ValidationIssue {
  level: 'block' | 'warn';
  /** 出问题的字段名；整表级问题为 undefined。 */
  field?: string;
  message: string;
  hint?: string;
}

/** 三段式结果。`data` 只在 `blocking` 为空时存在。 */
export interface ParseResult<T> {
  data?: T;
  /** 阻止保存的问题。非空时 `data` 为 undefined。 */
  blocking: ValidationIssue[];
  /** 通过但有提示的问题。不影响 `data` 产出。 */
  warnings: ValidationIssue[];
}

/** 引用完整性检查所需的外部信息，由调用方注入（本包不碰文件系统）。 */
export interface ParseOptions {
  /** 已知的 blog slug 列表，用于校验 projects.article 引用。 */
  knownBlogSlugs?: readonly string[];
  /** 判断 public/ 下某相对路径是否存在，用于校验 blog.cover。 */
  publicFileExists?: (relativePath: string) => boolean;
}

/** 分区 → schema 映射。 */
export const ENTRY_SCHEMAS = {
  blog: blogSchema,
  diary: diarySchema,
  projects: projectsSchema,
  goals: goalsSchema,
} as const satisfies Record<EntryKind, z.ZodType>;

/** 各分区的解析结果类型。 */
export type EntryOf<K extends EntryKind> = z.infer<(typeof ENTRY_SCHEMAS)[K]>;

/** cover 约定：以 / 开头、以 .svg 结尾。 */
const COVER_PATTERN = /^\/.*\.svg$/;

/** 把 Zod 的 issue 列表转成 blocking。 */
function toBlocking(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    level: 'block' as const,
    field: issue.path.length > 0 ? issue.path.join('.') : undefined,
    message: issue.message,
  }));
}

/**
 * 引用完整性检查，产出 warning（不阻断）。
 *
 * 对应 desktop `validateService.ts:174-204` 的两条规则：
 * - blog.cover 路径不符合 `/^\/.*\.svg$/`，或文件不存在 → 封面尺寸优化失效
 * - projects.article 指向不存在的 blog slug → 关联链接失效
 *
 * 站点构建都不会因此失败，所以是 warning 而非 blocking。
 */
function collectReferenceWarnings(
  kind: EntryKind,
  data: Record<string, unknown>,
  options: ParseOptions,
): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];

  if (kind === 'blog') {
    const cover = data.cover;
    if (typeof cover === 'string' && cover !== '') {
      if (!COVER_PATTERN.test(cover)) {
        warnings.push({
          level: 'warn',
          field: 'cover',
          message: `封面路径不符合约定：${cover}`,
          hint: '应以 / 开头且以 .svg 结尾',
        });
      } else if (options.publicFileExists && !options.publicFileExists(cover)) {
        warnings.push({
          level: 'warn',
          field: 'cover',
          message: `封面文件不存在：${cover}`,
          hint: '封面尺寸优化会失效，页面仍可构建',
        });
      }
    }
  }

  if (kind === 'projects') {
    const article = data.article;
    if (typeof article === 'string' && article !== '' && options.knownBlogSlugs) {
      if (!options.knownBlogSlugs.includes(article)) {
        warnings.push({
          level: 'warn',
          field: 'article',
          message: `article 指向不存在的 blog slug：${article}`,
          hint: '站点不校验，但项目页的关联链接会失效',
        });
      }
    }
  }

  return warnings;
}

/**
 * 解析一份 frontmatter 数据。
 *
 * 这是本包唯一的公共校验入口，读取 / 保存 / 发布前都应走它。
 *
 * @example
 * const result = parseEntry('blog', { title: 'x', description: 'y', date: '2026-08-26' });
 * if (result.blocking.length > 0) { ... }
 */
export function parseEntry<K extends EntryKind>(
  kind: K,
  raw: unknown,
  options: ParseOptions = {},
): ParseResult<EntryOf<K>> {
  if (!isEntryKind(kind)) {
    return {
      blocking: [
        {
          level: 'block',
          message: `未知内容分区：${String(kind)}`,
          hint: `允许值：blog / diary / projects / goals`,
        },
      ],
      warnings: [],
    };
  }

  // 各分区 schema 的输入/输出类型互不相同，这里退到 `ZodType`（输出 unknown）
  // 再在返回处断言成 EntryOf<K>，避免联合类型之间的不兼容转换。
  const schema: z.ZodType = ENTRY_SCHEMAS[kind];
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    return { blocking: toBlocking(parsed.error), warnings: [] };
  }

  const data = parsed.data as EntryOf<K>;
  const warnings = collectReferenceWarnings(
    kind,
    data as unknown as Record<string, unknown>,
    options,
  );
  return { data, blocking: [], warnings };
}

/**
 * 只校验 slug 是否合法。
 *
 * 单独导出是因为 slug 来自文件名而非 frontmatter，不走 parseEntry。
 */
export function isValidSlug(slug: unknown): slug is string {
  if (typeof slug !== 'string') return false;
  if (slug.length === 0 || slug.length > 200) return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) return false;
  return slug !== '.' && slug !== '..';
}
