/**
 * 链接安全测试（方案 §13.2 的两条要求）。
 *
 * ── 这个文件守的是什么 ────────────────────────────────────────────────
 * P6 的安全审计发现：正文里的 `[evil](javascript:alert(1))` 会被原样渲染成
 * `<a href="javascript:alert(1)">`，`![img](javascript:alert(2))` 会渲染成
 * `<img src="javascript:alert(2)">`，外链也没有任何 `rel`。这些在浏览器里都是活的
 * 攻击面，而 `tsc` 与「构建成功」都不会报错 —— 只有真跑一次渲染才看得见。
 *
 * 所以这里不做「配置对不对」的静态检查，而是**真的把 Markdown 渲染一遍**，
 * 断言最终 HTML 字符串的形状。
 *
 * ── 为什么一个用例要断言多个点 ────────────────────────────────────────
 * 安全清洗的正确行为是「同时满足」：危险 URL 必须消失（负向）**且**正文文本必须
 * 还在（正向）。只断言「不含 javascript:」是不够的 —— 把整个段落删掉也能过，
 * 那属于过度清洗。每条用例都成对断言，才不会用「删得更多」冒充「修得更好」。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   node --test-isolation=none packages/markdown/src/__tests__/safe-links.test.ts
 *
 * 本包没有配 vitest 的可执行路径（本机沙箱里 vitest 的 spawn 被拒），
 * 因此统一用 `node:test`，与 `apps/web` 下那批测试保持一致。
 *
 * 文件头部的 `registerHooks` 解决的是另一个问题：`pipeline.ts` 内部用
 * `import ... from './highlighter'`（无扩展名）引用同目录文件，Node 的 ESM 解析器
 * 不做扩展名补全，必须挂一个 resolve 钩子把 `.ts` 补上，否则直接
 * `ERR_MODULE_NOT_FOUND`。
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const isRelative =
        specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:');
      if (!isRelative) throw error;
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
      const bare = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier;
      const target = resolvePath(dirname(parent), bare);
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        if (existsSync(target + ext)) {
          return { url: pathToFileURL(target + ext).href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderMarkdownSync, renderMarkdown } = await import('../pipeline.ts');
const { listContentSamples } = await import('./fixtures.ts');

/** 从输出里抠出某个标签的全部开标签文本，便于逐属性断言。 */
function anchorsOf(html: string): string[] {
  return html.match(/<a\b[^>]*>/g) ?? [];
}

function imagesOf(html: string): string[] {
  return html.match(/<img\b[^>]*>/g) ?? [];
}

/**
 * 输出里是否存在 `<a ... href=...>` 这个属性。
 *
 * **不能写成 `html.includes('href=')`**：清洗标记本身叫 `data-unsafe-href="removed"`，
 * 里面就含着 `href=` 子串，用子串判断会把「已经删干净」误判成「还在」。
 * 这里锚在标签内部、且要求属性名前是空白或标签起点，才不会和 `data-unsafe-href` 混淆。
 */
function hasAttr(html: string, attr: 'href' | 'src'): boolean {
  return new RegExp(`<[a-z][^>]*\\s${attr}\\s*=`, 'i').test(html);
}

// ---------------------------------------------------------------------------
// 一、危险协议必须被降级
// ---------------------------------------------------------------------------

test('javascript: 链接去 href、留文本、打标记', () => {
  const html = renderMarkdownSync('[evil](javascript:alert(1))');

  // 负向：href 属性不见了，且整段输出里再也找不到那个协议
  assert.ok(!hasAttr(html, 'href'), `href 仍然存在：${html}`);
  assert.ok(!html.includes('javascript'), `仍含 javascript：${html}`);

  // 正向：文本"evil"还在（不是把整段删掉），且带着清洗标记
  assert.ok(html.includes('>evil</a>'), `链接文本丢了：${html}`);
  assert.ok(html.includes('data-unsafe-href="removed"'), `缺少清洗标记：${html}`);
});

test('大小写混写与 vbscript: 同样被降级', () => {
  const mixed = renderMarkdownSync('[b](JaVaScRiPt:alert(1))');
  assert.ok(!hasAttr(mixed, 'href'), `混写大小写绕过：${mixed}`);
  assert.ok(mixed.includes('data-unsafe-href="removed"'), mixed);

  const vb = renderMarkdownSync('[c](vbscript:msgbox(1))');
  assert.ok(!hasAttr(vb, 'href'), `vbscript 未拦：${vb}`);
  assert.ok(vb.includes('data-unsafe-href="removed"'), vb);
});

test('HTML 实体编码的协议被解码后再判定', () => {
  // `&#106;` 是字母 j。remark-rehype 会先解码实体，插件拿到的是已经解好的 URL。
  // 若判定发生在解码之前，这里会漏网 —— 所以这条用例是防"将来有人把插件挪到前面去"。
  const html = renderMarkdownSync('[e](&#106;avascript:alert(1))');
  assert.ok(!hasAttr(html, 'href'), `实体编码绕过：${html}`);
  assert.ok(html.includes('data-unsafe-href="removed"'), html);
});

test('data: 链接被禁，但 data: 图片放行（非对称处置）', () => {
  const link = renderMarkdownSync('[d](data:text/html,x)');
  assert.ok(!hasAttr(link, 'href'), `<a> 上的 data: 未拦：${link}`);
  assert.ok(link.includes('data-unsafe-href="removed"'), link);

  // 同一份协议放在 <img> 上必须放行：next.config.ts:117 的 CSP 明确允许 img-src data:。
  // 两处口径必须一致，否则「CSP 允许、渲染却说没 src」会变成反复排查的谜题。
  const img = renderMarkdownSync('![png](data:image/png;base64,iVBORw0KGgo=)');
  assert.ok(img.includes('src="data:image/png;base64,iVBORw0KGgo="'), `data: 图片被误伤：${img}`);
});

test('危险协议的图片去 src、但保留 alt', () => {
  const html = renderMarkdownSync('![img](javascript:alert(2))');
  assert.ok(!hasAttr(html, 'src'), `src 仍然存在：${html}`);
  assert.ok(!html.includes('javascript'), html);
  // alt 不是可执行内容，删掉只会让读者失去图片说明
  assert.ok(html.includes('alt="img"'), `alt 被误删：${html}`);
  assert.ok(html.includes('data-unsafe-src="removed"'), `缺少清洗标记：${html}`);
});

// ---------------------------------------------------------------------------
// 二、外链补 rel
// ---------------------------------------------------------------------------

test('http/https 外链补 noopener noreferrer', () => {
  for (const src of [
    '[ext](https://example.com/x)',
    '[ext](http://example.com/x)',
    // 协议大小写不应影响判定
    '[ext](HTTPS://Example.com/x)',
    // 协议相对地址：浏览器会用当前页协议补全，跳转结果与 https:// 完全一样
    '[ext](//example.com/x)',
  ]) {
    const html = renderMarkdownSync(src);
    const [anchor] = anchorsOf(html);
    assert.ok(anchor, `没渲染出链接：${src} → ${html}`);
    assert.match(anchor, /rel="noopener noreferrer"/, `${src} 未补 rel：${anchor}`);
    // 原 href 不能被改写（我们只加属性，不改用户写的目标）
    assert.ok(!anchor.includes('data-unsafe'), `${src} 被误判为危险：${anchor}`);
  }
});

test('外链不擅自加 target="_blank"', () => {
  // 方案只要求补 rel。加 target 会改变用户的浏览习惯（点链接变成新开标签页），
  // 安全收益来自 noopener，而不是来自新标签页 —— 顺手加需求外的东西是越权。
  const html = renderMarkdownSync('[ext](https://example.com/x)');
  assert.ok(!html.includes('target='), `擅自加了 target：${html}`);
});

// ---------------------------------------------------------------------------
// 三、内链与非导航协议必须原样不动
// ---------------------------------------------------------------------------

test('内链与 mailto/tel/ftp 不加 rel', () => {
  // 给站内跳转加 noreferrer 会让来源统计全部失真，而 noopener 在同源下没有意义。
  for (const src of [
    '[rel](./relative.md)',
    '[abs](/absolute)',
    '[anc](#anchor)',
    '[mail](mailto:a@b.c)',
    '[tel](tel:+8613800000000)',
    '[ftp](ftp://example.com/f)',
  ]) {
    const html = renderMarkdownSync(src);
    const [anchor] = anchorsOf(html);
    assert.ok(anchor, `没渲染出链接：${src} → ${html}`);
    assert.ok(!anchor.includes('rel='), `${src} 不该有 rel：${anchor}`);
    assert.ok(!anchor.includes('data-unsafe'), `${src} 被误判：${anchor}`);
  }
});

test('标题锚点不受影响（插件必须排在 autolink 之后）', () => {
  const html = renderMarkdownSync('## Hello');
  // rehype-autolink-headings 生成的 <a class="heading-anchor" href="#hello"> 也是 <a>，
  // 会被插件看见。它首字符是 `#`，不该被当成危险链接，也不该被加 rel。
  assert.ok(html.includes('id="hello"'), html);
  const [anchor] = anchorsOf(html);
  assert.ok(anchor, `标题锚点丢了：${html}`);
  assert.ok(anchor.includes('href="#hello"'), `锚点 href 被误删：${anchor}`);
  assert.ok(!anchor.includes('rel='), `锚点被加了 rel：${anchor}`);
});

// ---------------------------------------------------------------------------
// 四、真实内容回归
// ---------------------------------------------------------------------------

test('真实内容渲染后不含任何危险协议，也不该被清洗标记污染', () => {
  const samples = listContentSamples();
  assert.ok(samples.length >= 10, `真实内容样本数异常：${samples.length}`);

  for (const sample of samples) {
    const html = renderMarkdownSync(sample.body);
    const where = `${sample.kind}/${sample.slug}`;

    assert.ok(
      !/<(?:a|img)\b[^>]*(?:href|src)="\s*(?:javascript|vbscript):/i.test(html),
      `${where} 渲染出了危险 URL`,
    );

    // 现有 10 篇内容里零外链、零危险协议 —— 因此清洗标记与外链 rel 都不该出现。
    // 反过来说：只要这里出现一条，就说明插件误伤了真实内容（把内链当外链、
    // 或把正常 URL 判成危险），而这正是「加插件不能改变现有输出」的守门断言。
    assert.ok(!html.includes('data-unsafe-href'), `${where} 的某个链接被误判为危险`);
    assert.ok(!html.includes('data-unsafe-src'), `${where} 的某张图片被误判为危险`);
    assert.ok(!html.includes('rel="noopener'), `${where} 的某个内链被误判为外链`);
  }
});

test('真实内容里唯一的两条图片链接保持原样（加插件不得改变真实输出）', () => {
  // 10 篇真实内容里一共只有 2 条链接/图片，都是站内图片；外链一条都没有。
  // 因此「加插件」对真实内容的渲染字节理应毫无影响 —— 这条用例就是那个回归保护。
  const html = renderMarkdownSync(
    listContentSamples()
      .filter((s) => s.slug === 'langgraph-rag-workflow')
      .map((s) => s.body)
      .join('\n'),
  );
  assert.ok(html.includes('src="/images/langgraph-flow.svg"'), '站内图片被改写了');
  assert.ok(!html.includes('rel='), '站内图片不该出现 rel');
});

// ---------------------------------------------------------------------------
// 五、两条渲染路径必须一致
// ---------------------------------------------------------------------------

test('同步与异步两条路径对危险链接给出相同结果', async () => {
  const sources = [
    '[evil](javascript:alert(1))',
    '[ext](https://example.com/x)',
    '![img](javascript:alert(2))',
  ];

  for (const src of sources) {
    const sync = renderMarkdownSync(src);
    const async_ = await renderMarkdown(src);
    assert.equal(async_, sync, `同步/异步输出不一致：${src}`);
  }
});
