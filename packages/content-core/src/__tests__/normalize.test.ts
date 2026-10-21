import { describe, expect, it } from 'vitest';

import { dateToISODate } from '../primitives';
import { parseEntry } from '../parse';

/**
 * T4：归一化正确性。
 *
 * 这些用例覆盖的都是「真实数据会踩到、但朴素写法会出错」的点，
 * 尤其是 date 的时区陷阱（见 primitives.ts 的注释）。
 */

const blogBase = { title: 't', description: 'd', date: '2026-08-26' };

describe('T4 日期归一化', () => {
  it('YAML 裸日期（UTC 午夜的 Date）→ 正确日期', () => {
    const result = parseEntry('blog', { ...blogBase, date: new Date('2026-08-26') });
    expect(result.data?.date).toBe('2026-08-26');
  });

  it('本地构造的 Date → 不退一天', () => {
    // 本机 UTC+8：new Date(2026, 7, 26) 的 toISOString 是 2026-08-25T16:00:00Z，
    // 朴素 slice(0,10) 会得到 2026-08-25。此处断言必须得到 2026-08-26。
    const result = parseEntry('blog', { ...blogBase, date: new Date(2026, 7, 26) });
    expect(result.data?.date).toBe('2026-08-26');
  });

  it('本地 00:30 的 Date → 不退一天', () => {
    const result = parseEntry('blog', { ...blogBase, date: new Date(2026, 7, 26, 0, 30) });
    expect(result.data?.date).toBe('2026-08-26');
  });

  it('本地 23:30 的 Date → 不退一天', () => {
    const result = parseEntry('blog', { ...blogBase, date: new Date(2026, 7, 26, 23, 30) });
    expect(result.data?.date).toBe('2026-08-26');
  });

  it('带首尾空格的字符串 → trim 后通过', () => {
    const result = parseEntry('blog', { ...blogBase, date: '  2026-08-26  ' });
    expect(result.data?.date).toBe('2026-08-26');
  });

  it('dateToISODate 对 UTC 午夜与本地 Date 分别正确', () => {
    expect(dateToISODate(new Date('2026-08-26'))).toBe('2026-08-26');
    expect(dateToISODate(new Date(2026, 7, 26))).toBe('2026-08-26');
  });
});

describe('T4 字符串与数组归一化', () => {
  it('title / description 首尾空格被 trim', () => {
    const result = parseEntry('blog', { ...blogBase, title: '  hi  ', description: ' d ' });
    expect(result.data?.title).toBe('hi');
    expect(result.data?.description).toBe('d');
  });

  it('tags 去重 + trim + 丢弃空串', () => {
    const result = parseEntry('blog', { ...blogBase, tags: ['a', ' a ', 'b', '', '   ', 'a'] });
    expect(result.data?.tags).toEqual(['a', 'b']);
  });

  it('tags 缺失 → 空数组', () => {
    const result = parseEntry('blog', blogBase);
    expect(result.data?.tags).toEqual([]);
  });

  it('projects techStack 同样去重', () => {
    const result = parseEntry('projects', {
      name: 'n',
      description: 'd',
      status: 'active',
      techStack: ['Python', 'Python', ' Python ', ''],
    });
    expect(result.data?.techStack).toEqual(['Python']);
  });
});

describe('T4 默认值', () => {
  it('blog category 缺失 → 未分类', () => {
    const result = parseEntry('blog', blogBase);
    expect(result.data?.category).toBe('未分类');
  });

  it('blog category 为空串 → 未分类', () => {
    const result = parseEntry('blog', { ...blogBase, category: '' });
    expect(result.data?.category).toBe('未分类');
  });

  it('blog draft 缺失 → false', () => {
    const result = parseEntry('blog', blogBase);
    expect(result.data?.draft).toBe(false);
  });

  it('projects featured 缺失 → false', () => {
    const result = parseEntry('projects', { name: 'n', description: 'd', status: 'active' });
    expect(result.data?.featured).toBe(false);
  });

  it('goals progress 缺失 → 0', () => {
    const result = parseEntry('goals', { title: 't', horizon: 'long', status: 'active' });
    expect(result.data?.progress).toBe(0);
  });

  it('goals milestones 缺失 → 空数组', () => {
    const result = parseEntry('goals', { title: 't', horizon: 'long', status: 'active' });
    expect(result.data?.milestones).toEqual([]);
  });
});

describe('T4 order 空值处理（coerce 陷阱）', () => {
  // 陷阱：z.coerce.number().int().default(999) 对 "" / null 会得到 0 而不是 999，
  // 因为 coerce 先把 "" 变成 Number("") === 0，default 只处理 undefined。
  // 后果：frontmatter 写了 `order:` 但值为空时，排序会跑到最前面。
  it('order 缺失 → 999', () => {
    const result = parseEntry('projects', { name: 'n', description: 'd', status: 'active' });
    expect(result.data?.order).toBe(999);
  });

  it('order 为空串 → 999（不是 0）', () => {
    const result = parseEntry('projects', {
      name: 'n',
      description: 'd',
      status: 'active',
      order: '',
    });
    expect(result.data?.order).toBe(999);
  });

  it('order 为 null → 999（不是 0）', () => {
    const result = parseEntry('projects', {
      name: 'n',
      description: 'd',
      status: 'active',
      order: null,
    });
    expect(result.data?.order).toBe(999);
  });

  it('order 为纯空白串 → 999', () => {
    const result = parseEntry('projects', {
      name: 'n',
      description: 'd',
      status: 'active',
      order: '   ',
    });
    expect(result.data?.order).toBe(999);
  });

  it('order 为字符串数字 "1" → 1（强转，不是 999）', () => {
    // 站点现状（projects.ts:79）判 typeof === "number"，字符串 "1" 会退化成 999
    const result = parseEntry('projects', {
      name: 'n',
      description: 'd',
      status: 'active',
      order: '1',
    });
    expect(result.data?.order).toBe(1);
  });

  it('order 为 0 → 0（0 是合法值，不能被当成缺省）', () => {
    const result = parseEntry('projects', {
      name: 'n',
      description: 'd',
      status: 'active',
      order: 0,
    });
    expect(result.data?.order).toBe(0);
  });

  it('goals order 同样处理空值', () => {
    const result = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      order: '',
    });
    expect(result.data?.order).toBe(999);
  });
});

describe('T4 progress 小数归一（用户裁决）', () => {
  it('progress 50.6 → 51（round，不报错）', () => {
    const result = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: 50.6,
    });
    expect(result.blocking).toEqual([]);
    expect(result.data?.progress).toBe(51);
  });

  it('progress 51.4 → 51', () => {
    const result = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: 51.4,
    });
    expect(result.data?.progress).toBe(51);
  });

  it('progress 边界 0 与 100 均通过', () => {
    const zero = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: 0,
    });
    const hundred = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: 100,
    });
    expect(zero.data?.progress).toBe(0);
    expect(hundred.data?.progress).toBe(100);
  });

  it('progress 为空串 → 0（不是 blocking）', () => {
    const result = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: '',
    });
    expect(result.blocking).toEqual([]);
    expect(result.data?.progress).toBe(0);
  });
});
