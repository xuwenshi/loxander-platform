import { describe, expect, it } from 'vitest';

import { canBeEmpty, ENTRY_KINDS, MIN_ENTRY_COUNT } from '../kinds';
import { parseEntry } from '../parse';
import { knownBlogSlugs, listContentFiles, publicFileExists } from './fixtures';

/**
 * T1–T2：真实内容契约 + 分区结构性不变量。
 *
 * 原则（沿用 electron-cms `schema.contract.test.ts`）：
 * **不断言具体篇数** —— 内容随时会增删，这正是 CMS 的用途；只断言结构性不变量。
 */

const files = listContentFiles();
const blogSlugs = knownBlogSlugs();

describe('T1 真实内容全部通过 parseEntry', () => {
  it('apps/web/content 下确实存在真实内容', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('每篇真实内容都无 blocking、无 warning', () => {
    for (const item of files) {
      const result = parseEntry(item.kind, item.data, {
        knownBlogSlugs: blogSlugs,
        publicFileExists,
      });
      const label = `${item.kind}/${item.slug}`;

      expect(result.blocking, `${label} 不应有 blocking`).toEqual([]);
      expect(result.warnings, `${label} 不应有 warning`).toEqual([]);
      expect(result.data, `${label} 应产出 data`).toBeDefined();
    }
  });

  it('每篇真实内容的必填字段齐全', () => {
    for (const item of files) {
      const result = parseEntry(item.kind, item.data, { knownBlogSlugs: blogSlugs });
      expect(result.data, `${item.kind}/${item.slug}`).toBeDefined();
    }
  });
});

describe('T2 分区结构性不变量', () => {
  it('四分区均可枚举', () => {
    const counts = Object.fromEntries(
      ENTRY_KINDS.map((kind) => [kind, files.filter((item) => item.kind === kind).length]),
    );
    expect(Object.keys(counts).sort()).toEqual([...ENTRY_KINDS].sort());
  });

  it('blog / diary / projects 至少各 1 篇（generateStaticParams 不接受空数组）', () => {
    for (const kind of ['blog', 'diary', 'projects'] as const) {
      const count = files.filter((item) => item.kind === kind).length;
      expect(count, `${kind} 不允许为空`).toBeGreaterThanOrEqual(1);
    }
  });

  it('goals 允许为空', () => {
    expect(MIN_ENTRY_COUNT.goals).toBe(0);
    expect(canBeEmpty('goals')).toBe(true);
    expect(canBeEmpty('blog')).toBe(false);
    expect(canBeEmpty('diary')).toBe(false);
    expect(canBeEmpty('projects')).toBe(false);
  });
});
