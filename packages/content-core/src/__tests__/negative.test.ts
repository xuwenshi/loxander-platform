import { describe, expect, it } from 'vitest';

import { parseEntry } from '../parse';

/**
 * T3：负向用例。
 *
 * 正向测试证明不了校验器有用——只有「坏数据确实被拦住」才证明。
 * 每条用例都标注了它与旧实现的差异，避免日后有人「修复」掉这些严格性。
 */

const fieldsOf = (result: ReturnType<typeof parseEntry>): string[] =>
  result.blocking.map((issue) => issue.field).filter((field): field is string => Boolean(field));

describe('T3 负向用例：必填字段', () => {
  it('blog 缺 title → blocking 且字段指向 title', () => {
    const result = parseEntry('blog', { description: '有描述', date: '2026-01-01' });
    expect(result.blocking.length).toBeGreaterThan(0);
    expect(fieldsOf(result)).toContain('title');
    expect(result.data).toBeUndefined();
  });

  it('blog title 为纯空白 → blocking', () => {
    const result = parseEntry('blog', { title: '   ', description: 'd', date: '2026-01-01' });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('diary 缺 summary → blocking', () => {
    const result = parseEntry('diary', { title: 't', date: '2026-01-01' });
    expect(fieldsOf(result)).toContain('summary');
  });

  it('projects 缺 name → blocking', () => {
    const result = parseEntry('projects', { description: 'd', status: 'active' });
    expect(fieldsOf(result)).toContain('name');
  });

  it('goals 缺 title → blocking', () => {
    const result = parseEntry('goals', { horizon: 'long', status: 'active' });
    expect(fieldsOf(result)).toContain('title');
  });
});

describe('T3 负向用例：日期严格性（比 web 现状更严）', () => {
  it('blog date 用斜杠 2026/01/01 → blocking', () => {
    // 站点现状（apps/web/src/lib/posts.ts:34）只判非空字符串，这条会被放过
    const result = parseEntry('blog', { title: 't', description: 'd', date: '2026/01/01' });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('blog date 带尾随字符 2026-10-12xyz → blocking', () => {
    // 站点现状无正则，这条会被放过
    const result = parseEntry('blog', { title: 't', description: 'd', date: '2026-10-12xyz' });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('diary date 带尾随字符 2026-10-12xyz → blocking', () => {
    // 站点现状（apps/web/src/lib/diary.ts:57）正则缺 `$`，这条会被放过；此处是修复
    const result = parseEntry('diary', { title: 't', summary: 's', date: '2026-10-12xyz' });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('diary date 用斜杠 → blocking', () => {
    const result = parseEntry('diary', { title: 't', summary: 's', date: '2026/10/12' });
    expect(result.blocking.length).toBeGreaterThan(0);
  });
});

describe('T3 负向用例：枚举与数值', () => {
  it('projects status 非法 → blocking', () => {
    const result = parseEntry('projects', { name: 'n', description: 'd', status: 'unknown' });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('projects order 非数字字符串 → blocking', () => {
    const result = parseEntry('projects', {
      name: 'n',
      description: 'd',
      status: 'active',
      order: 'abc',
    });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('projects order 小数 → blocking（排序必须是整数）', () => {
    const result = parseEntry('projects', {
      name: 'n',
      description: 'd',
      status: 'active',
      order: 2.5,
    });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('goals horizon 非法 → blocking', () => {
    const result = parseEntry('goals', { title: 't', horizon: 'forever', status: 'active' });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('goals status 非法 → blocking', () => {
    const result = parseEntry('goals', { title: 't', horizon: 'long', status: 'unknown' });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('goals progress 130 → blocking（用户裁决：不静默夹取）', () => {
    // 站点现状（goals.ts:73）会静默夹到 100；desktop 是 clamp + warning。
    // P1 用户裁决：越界属于填写错误，必须 blocking。
    const result = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: 130,
    });
    expect(result.blocking.length).toBeGreaterThan(0);
    expect(result.data).toBeUndefined();
  });

  it('goals progress -5 → blocking', () => {
    const result = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      progress: -5,
    });
    expect(result.blocking.length).toBeGreaterThan(0);
  });
});

describe('T3 负向用例：milestones 阻断（比 web 现状更严）', () => {
  it('milestones 含空 title → blocking', () => {
    // 站点现状（goals.ts:76-84）用 flatMap 静默丢弃坏项；此处改为阻断
    const result = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      milestones: [{ title: '', done: false }],
    });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('milestones 非数组 → blocking', () => {
    const result = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      milestones: 'not-an-array',
    });
    expect(result.blocking.length).toBeGreaterThan(0);
  });

  it('milestones 项缺 done → blocking', () => {
    const result = parseEntry('goals', {
      title: 't',
      horizon: 'long',
      status: 'active',
      milestones: [{ title: 'ok' }],
    });
    expect(result.blocking.length).toBeGreaterThan(0);
  });
});

describe('T3 负向用例：未知分区', () => {
  it('未知 kind → blocking 且无 data', () => {
    const result = parseEntry('nope' as never, {});
    expect(result.blocking.length).toBeGreaterThan(0);
    expect(result.data).toBeUndefined();
  });
});
