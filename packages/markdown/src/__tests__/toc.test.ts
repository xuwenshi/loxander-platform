import { describe, expect, it } from 'vitest';

import { extractHeadings } from '../toc';
import { renderMarkdown } from '../pipeline';

/**
 * T2：目录锚点必须与正文标题 id **完全一致**。
 *
 * 这是旧实现真实存在的 bug：`extractHeadings` 在 mdast 上自己算 slug，
 * 而正文 id 是 `rehype-slug` 在 hast 上算的。两者只在「标题里含行内 raw HTML」时分歧，
 * 因为 mdast 的 `html` 节点在 `nodeToText` 里取不到值，而 hast 的 `raw` 节点在
 * slug 计算时会被丢弃/展开。
 *
 * 下面的用例就是当时实测出的三个反例，锁定为回归测试。
 */

/** 从渲染结果里抽出所有 h2/h3 的 id（按文档顺序）。 */
function headingIdsFromHtml(html: string): string[] {
  const ids: string[] = [];
  const pattern = /<h([23]) id="([^"]+)"/g;
  let match = pattern.exec(html);

  while (match) {
    ids.push(match[2]);
    match = pattern.exec(html);
  }

  return ids;
}

describe('目录锚点与正文 id 一致', () => {
  it('行内注释不污染锚点', async () => {
    const markdown = '## a <!-- c --> b';
    const html = await renderMarkdown(markdown);
    const headings = extractHeadings(markdown);

    expect(headingIdsFromHtml(html)).toEqual(headings.map((item) => item.id));
    // 旧实现算出的是 "a----c----b"
    expect(headings.map((item) => item.id)).toEqual(['a--b']);
  });

  it('行内元素只贡献可见文本', async () => {
    const markdown = '## Title <span>x</span> tail';
    const html = await renderMarkdown(markdown);
    const headings = extractHeadings(markdown);

    expect(headingIdsFromHtml(html)).toEqual(headings.map((item) => item.id));
    // 旧实现算出的是 "title-spanxspan-tail"
    expect(headings.map((item) => item.id)).toEqual(['title-x-tail']);
  });

  it('空元素不留下标签名', async () => {
    const markdown = '## Title <br> tail';
    const html = await renderMarkdown(markdown);
    const headings = extractHeadings(markdown);

    expect(headingIdsFromHtml(html)).toEqual(headings.map((item) => item.id));
    // 旧实现算出的是 "title-br-tail"
    expect(headings.map((item) => item.id)).toEqual(['title--tail']);
  });

  it('只收 h2 / h3，且层级正确', () => {
    const headings = extractHeadings('# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n');

    expect(headings.map((item) => item.level)).toEqual([2, 3]);
    expect(headings.map((item) => item.text)).toEqual(['二级', '三级']);
  });

  it('重复标题由同一个 slugger 去重，目录与正文同步', async () => {
    const markdown = '## 重复\n\n## 重复\n';
    const html = await renderMarkdown(markdown);
    const headings = extractHeadings(markdown);

    expect(headings.map((item) => item.id)).toEqual(['重复', '重复-1']);
    expect(headingIdsFromHtml(html)).toEqual(['重复', '重复-1']);
  });

  it('标题里的行内代码保留可见文本', async () => {
    const markdown = '## 使用 `useMemo` 缓存';
    const html = await renderMarkdown(markdown);
    const headings = extractHeadings(markdown);

    expect(headingIdsFromHtml(html)).toEqual(headings.map((item) => item.id));
    expect(headings[0]?.text).toBe('使用 useMemo 缓存');
  });
});

describe('目录与正文在真实内容上的整体一致性', () => {
  it('每篇真实内容的目录 id 都能在正文里找到对应标题', async () => {
    const { listContentSamples } = await import('./fixtures');
    const mismatched: string[] = [];

    for (const sample of listContentSamples()) {
      const html = await renderMarkdown(sample.body);
      const htmlIds = headingIdsFromHtml(html);
      const tocIds = extractHeadings(sample.body).map((item) => item.id);

      // 目录是正文 h2/h3 的子序列（可能有 h1/h4 未进目录，但顺序与取值必须一致）
      const filtered = htmlIds.filter((id) => tocIds.includes(id));
      if (filtered.length !== tocIds.length || filtered.some((id, i) => id !== tocIds[i])) {
        mismatched.push(`${sample.kind}/${sample.slug}`);
      }
    }

    expect(mismatched).toEqual([]);
  });
});
