import { describe, expect, it } from 'vitest';

import { getHighlighter } from '../highlighter';
import { renderMarkdown, renderMarkdownSync } from '../pipeline';
import { listContentSamples } from './fixtures';

/**
 * T3：高亮必须真的生效。
 *
 * 这里有一条容易踩空的陷阱：`createHighlighterCoreSync` 的 `langs` 传空数组**不会报错**，
 * 而是让所有语言静默退化成 plaintext —— 页面看起来「能渲染」，但代码块全无颜色，
 * 而且没有任何错误提示。所以必须显式断言「加载了哪些语言」以及「输出里真的有颜色 span」。
 */
describe('Shiki 高亮', () => {
  it('语言与主题都已加载（防止 langs 静默为空）', () => {
    const highlighter = getHighlighter();

    expect(highlighter.getLoadedThemes()).toEqual(
      expect.arrayContaining(['github-light', 'github-dark']),
    );

    // 内容里实际用到的语言：python / typescript / bash / css / html
    for (const lang of ['python', 'typescript', 'bash', 'css', 'html', 'json', 'yaml']) {
      expect(highlighter.getLoadedLanguages()).toContain(lang);
    }
  });

  it('已知语言产出带颜色的 span，而不是退化成纯文本', async () => {
    const html = await renderMarkdown('```python\ndef add(a, b):\n    return a + b\n```\n');

    expect(html).toContain('style="color:');
    // 双主题：浅色主题的颜色作为默认，深色主题的颜色放进自定义属性
    expect(html).toContain('--shiki-dark:');
  });

  it('未知语言退化但不抛错', async () => {
    const html = await renderMarkdown('```not-a-real-language\nplain text\n```\n');

    expect(html).toContain('plain text');
  });

  it('无语言标记的代码块不抛错', async () => {
    const html = renderMarkdownSync('```\nplain fence\n```\n');

    expect(html).toContain('plain fence');
  });
});

describe('代码块语言标识', () => {
  it('已知语言写进 data-language', async () => {
    const html = await renderMarkdown('```python\nx = 1\n```\n');

    expect(html).toContain('class="code-block"');
    expect(html).toContain('data-language="python"');
  });

  it('plaintext 不写 data-language（避免显示无意义标签）', async () => {
    const html = await renderMarkdown('```\njust text\n```\n');

    expect(html).toContain('class="code-block"');
    expect(html).not.toContain('data-language="plaintext"');
  });

  it('代码块被包进 .code-block 容器（横向滚动容器外侧）', async () => {
    const html = renderMarkdownSync('```js\nconst a = 1;\n```\n');

    expect(html).toMatch(/<div class="code-block" data-language="(js|javascript)"><pre/);
  });
});

describe('标题层级偏移', () => {
  it('不传偏移时保持原层级', async () => {
    const html = await renderMarkdown('## 二级\n\n### 三级\n');

    expect(html).toContain('<h2 id="二级">');
    expect(html).toContain('<h3 id="三级">');
  });

  it('偏移 2 后 h2 → h4、h3 → h5', async () => {
    const html = await renderMarkdown('## 二级\n\n### 三级\n', { headingOffset: 2 });

    expect(html).toContain('<h4 id="二级">');
    expect(html).toContain('<h5 id="三级">');
  });

  it('偏移后不超过 h6', async () => {
    const html = await renderMarkdown('##### 五级\n', { headingOffset: 3 });

    expect(html).toContain('<h6 id="五级">');
  });

  it('偏移只改标签名，锚点 id 不变', async () => {
    const html = await renderMarkdown('## Hello World\n', { headingOffset: 2 });

    expect(html).toContain('id="hello-world"');
    expect(html).toContain('href="#hello-world"');
  });
});

describe('真实内容渲染', () => {
  const samples = listContentSamples();

  it('全部真实内容都能渲染出非空 HTML', async () => {
    for (const sample of samples) {
      const html = await renderMarkdown(sample.body);
      expect(html.length, `${sample.kind}/${sample.slug}`).toBeGreaterThan(0);
    }
  });

  it('真实内容里的代码块都带上 .code-block 容器', async () => {
    const mismatched: string[] = [];

    for (const sample of samples) {
      const html = await renderMarkdown(sample.body);
      const fences = (sample.body.match(/^```/gm) ?? []).length / 2;

      if (fences > 0 && !html.includes('class="code-block"')) {
        mismatched.push(`${sample.kind}/${sample.slug}（${fences} 个围栏但无容器）`);
      }
    }

    expect(mismatched).toEqual([]);
  });
});
