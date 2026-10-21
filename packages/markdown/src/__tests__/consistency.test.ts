import { describe, expect, it } from 'vitest';

import { renderMarkdown, renderMarkdownSync } from '../pipeline';
import { listContentSamples } from './fixtures';

/**
 * T1：同步与异步两条渲染路径必须**逐字节相同**。
 *
 * 这是整个包的核心承诺。站点走异步、桌面端走同步，一旦两者输出不同，
 * 用户在后台看到的预览就和线上页面不一致 —— 那正是本包要消除的问题。
 * 所以这里不是「抽查几个用例」，而是把全部真实内容逐篇比对。
 */
describe('同步与异步渲染一致性', () => {
  const samples = listContentSamples();

  it('真实内容全部覆盖（防止夹具静默变空）', () => {
    expect(samples.length).toBeGreaterThanOrEqual(10);
  });

  it('每篇真实内容的同步输出与异步输出逐字节相同', async () => {
    const mismatched: string[] = [];

    for (const sample of samples) {
      const syncHtml = renderMarkdownSync(sample.body);
      const asyncHtml = await renderMarkdown(sample.body);

      if (syncHtml !== asyncHtml) {
        mismatched.push(`${sample.kind}/${sample.slug}`);
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('带 headingOffset 时两条路径同样一致', async () => {
    const mismatched: string[] = [];

    for (const sample of samples) {
      const syncHtml = renderMarkdownSync(sample.body, { headingOffset: 2 });
      const asyncHtml = await renderMarkdown(sample.body, { headingOffset: 2 });

      if (syncHtml !== asyncHtml) {
        mismatched.push(`${sample.kind}/${sample.slug}`);
      }
    }

    expect(mismatched).toEqual([]);
  });
});
