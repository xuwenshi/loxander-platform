import { describe, expect, it } from 'vitest';

import { SLUG_MAX_LENGTH } from '../kinds';
import { isValidSlug, parseEntry } from '../parse';

/**
 * T5：slug 规则。
 *
 * 采纳 desktop `pathGuard.ts` 的 SAFE_SLUG（1–200 字符、字母数字点下划线连字符、
 * 排除 `.` 与 `..`）。站点现状完全没有 slug 校验，因此这里比 web 更严。
 */

describe('T5 slug 合法性', () => {
  it('真实内容的 slug 全部合法', () => {
    const realSlugs = [
      'agriculture-feature-engineering',
      'build-personal-blog-with-nextjs',
      'langgraph-rag-workflow',
      'rag-chunking-strategies',
      'week01',
      'crop-yield-prediction',
      'personal-blog-platform',
      'rag-knowledge-assistant',
      '01-example-short',
      '02-example-long',
    ];
    for (const slug of realSlugs) {
      expect(isValidSlug(slug), `${slug} 应合法`).toBe(true);
    }
  });

  it('允许字母数字点下划线连字符', () => {
    expect(isValidSlug('a.b_c-d')).toBe(true);
    expect(isValidSlug('ABC123')).toBe(true);
    expect(isValidSlug('a')).toBe(true);
  });

  it('拒绝路径穿越形态', () => {
    expect(isValidSlug('../escape')).toBe(false);
    expect(isValidSlug('..')).toBe(false);
    expect(isValidSlug('.')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
    expect(isValidSlug('a\\b')).toBe(false);
  });

  it('拒绝空格与特殊字符', () => {
    expect(isValidSlug('a b')).toBe(false);
    expect(isValidSlug('a@b')).toBe(false);
    expect(isValidSlug('中文')).toBe(false);
  });

  it('拒绝空串与超长', () => {
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('x'.repeat(SLUG_MAX_LENGTH + 1))).toBe(false);
    expect(isValidSlug('x'.repeat(SLUG_MAX_LENGTH))).toBe(true);
  });

  it('拒绝非字符串', () => {
    expect(isValidSlug(null)).toBe(false);
    expect(isValidSlug(undefined)).toBe(false);
    expect(isValidSlug(123)).toBe(false);
    expect(isValidSlug({})).toBe(false);
  });
});

/**
 * T6：引用完整性 —— 产出 warning 而非 blocking。
 *
 * 对应 desktop `validateService.ts:174-204`。这类问题站点仍可构建，
 * 只是关联链接失效或封面尺寸优化失效，因此不该阻断保存。
 */

describe('T6 引用完整性（warning 而非 blocking）', () => {
  it('projects.article 指向不存在的 slug → warning，不阻断', () => {
    const result = parseEntry(
      'projects',
      { name: 'n', description: 'd', status: 'active', article: 'no-such-post' },
      { knownBlogSlugs: ['real-post'] },
    );
    expect(result.blocking).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]?.field).toBe('article');
    expect(result.data).toBeDefined();
  });

  it('projects.article 指向存在的 slug → 无 warning', () => {
    const result = parseEntry(
      'projects',
      { name: 'n', description: 'd', status: 'active', article: 'real-post' },
      { knownBlogSlugs: ['real-post'] },
    );
    expect(result.warnings).toEqual([]);
  });

  it('未提供 knownBlogSlugs 时跳过 article 检查', () => {
    const result = parseEntry('projects', {
      name: 'n',
      description: 'd',
      status: 'active',
      article: 'anything',
    });
    expect(result.warnings).toEqual([]);
  });

  it('blog.cover 不是 .svg → warning，不阻断', () => {
    const result = parseEntry('blog', {
      title: 't',
      description: 'd',
      date: '2026-08-26',
      cover: '/images/x.png',
    });
    expect(result.blocking).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]?.field).toBe('cover');
  });

  it('blog.cover 是 .svg 但文件不存在 → warning', () => {
    const result = parseEntry(
      'blog',
      { title: 't', description: 'd', date: '2026-08-26', cover: '/images/missing.svg' },
      { publicFileExists: () => false },
    );
    expect(result.blocking).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('blog.cover 是 .svg 且文件存在 → 无 warning', () => {
    const result = parseEntry(
      'blog',
      { title: 't', description: 'd', date: '2026-08-26', cover: '/images/ok.svg' },
      { publicFileExists: () => true },
    );
    expect(result.warnings).toEqual([]);
  });

  it('无 cover 时不产生 warning', () => {
    const result = parseEntry(
      'blog',
      { title: 't', description: 'd', date: '2026-08-26' },
      { publicFileExists: () => false },
    );
    expect(result.warnings).toEqual([]);
  });
});
