import { describe, expect, it } from 'vitest';

import { parseEntry } from '../parse';
import { knownBlogSlugs, listContentFiles, publicFileExists } from './fixtures';

/**
 * T7：幂等 / roundtrip。
 *
 * 保证「解析两次结果相同」与「解析结果再解析不变」。
 * 这对后续的导入器（Markdown → DB）很重要：同一份数据被反复处理不应漂移。
 */

const files = listContentFiles();
const blogSlugs = knownBlogSlugs();

describe('T7 解析幂等', () => {
  it('同一份输入解析两次结果相同', () => {
    const input = { title: 't', description: 'd', date: '2026-08-26', tags: ['a', 'b'] };
    const first = parseEntry('blog', input);
    const second = parseEntry('blog', input);
    expect(first.data).toEqual(second.data);
    expect(first.blocking).toEqual(second.blocking);
    expect(first.warnings).toEqual(second.warnings);
  });

  it('解析结果再解析一次不变（归一幂等）', () => {
    const input = { title: '  t  ', description: 'd', date: '2026-08-26', tags: [' a ', 'a', 'b'] };
    const first = parseEntry('blog', input);
    expect(first.data).toBeDefined();

    const second = parseEntry('blog', first.data);
    expect(second.blocking).toEqual([]);
    expect(second.data).toEqual(first.data);
  });

  it('真实内容解析结果再解析不变', () => {
    for (const item of files) {
      const first = parseEntry(item.kind, item.data, {
        knownBlogSlugs: blogSlugs,
        publicFileExists,
      });
      expect(first.data, `${item.kind}/${item.slug}`).toBeDefined();

      const second = parseEntry(item.kind, first.data, {
        knownBlogSlugs: blogSlugs,
        publicFileExists,
      });
      expect(second.blocking, `${item.kind}/${item.slug} 二次解析不应有 blocking`).toEqual([]);
      expect(second.data, `${item.kind}/${item.slug} 二次解析结果应相同`).toEqual(first.data);
    }
  });

  it('date 归一后是字符串，再次解析仍通过', () => {
    const first = parseEntry('blog', { title: 't', description: 'd', date: new Date(2026, 7, 26) });
    expect(typeof first.data?.date).toBe('string');
    const second = parseEntry('blog', first.data);
    expect(second.data?.date).toBe(first.data?.date);
  });

  it('order 归一后再次解析保持稳定（999 不会变成 0）', () => {
    const first = parseEntry('projects', {
      name: 'n',
      description: 'd',
      status: 'active',
      order: '',
    });
    expect(first.data?.order).toBe(999);
    const second = parseEntry('projects', first.data);
    expect(second.data?.order).toBe(999);
  });

  it('progress 归一后再次解析保持稳定', () => {
    const first = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: 50.6,
    });
    expect(first.data?.progress).toBe(51);
    const second = parseEntry('goals', first.data);
    expect(second.data?.progress).toBe(51);
  });
});
