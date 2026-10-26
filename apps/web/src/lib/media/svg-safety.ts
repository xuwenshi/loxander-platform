/**
 * SVG 安全检查：拒绝带脚本 / 事件属性 / 危险 URL / 外部实体的 SVG。
 *
 * ── 为什么「拒绝」而不是「清洗」──────────────────────────────────────
 * 方案 §13.3 写的是「拒绝 SVG 中的脚本，必要时先清洗」。这里选拒绝，理由有三条：
 *
 * ① **清洗需要完整的 XML 解析器 + 白名单**。SVG 规范里能执行脚本的位置远不止
 *    `<script>`：`<a href="javascript:">`、`<use href="data:...">`、
 *    `<animate attributeName="href" values="javascript:...">`、
 *    `<foreignObject>` 里内嵌的 HTML、`<!ENTITY>` 展开（XXE / billion laughs）。
 *    漏掉任何一类，白名单就等于没有。手写正则做清洗是「看起来安全」的典型形态。
 * ② **本项目的 SVG 是作者手写的封面图**（`packages/content-core` 的 `cover`
 *    校验只认 `.svg`），一共十几个文件，全部是纯 `<path>` / `<circle>`。
 *    没有「用户上传任意 SVG」这个真实需求，清洗带来的灵活性是零收益。
 * ③ **失败方向**：拒绝会让上传者看到一条明确错误并改用 PNG；清洗失败会让
 *    恶意文件进对象存储并拿到一个公网 URL。前者可恢复，后者不可。
 *
 * ── 为什么这一层必须存在 ────────────────────────────────────────────
 * 同源上传的 SVG 一旦被浏览器当作图片直接打开（`/media/2026/10/x.svg`），
 * SVG 内的脚本在**本站源**下执行，可读 `document.cookie`、可发同源请求。
 * `Content-Security-Policy: script-src 'self' 'unsafe-inline'` 拦不住它 ——
 * `'self'` 恰好放行了同源脚本。这是「上传即 XSS」的经典路径。
 *
 * ── 为什么检查全部字节而不是只看前 4 KB ─────────────────────────────
 * 尺寸（`width`/`height`）在根元素上，读前 4 KB 就够；但**安全检查不能截断**：
 * 把 `<script>` 放在第 5001 字节就能绕过只查头部的实现。这是本文件与
 * `image-info.ts` 的 `svgSize` 关键差别，也是为什么安全函数要独立存在。
 */

/** 允许的 SVG 尺寸上限。超过这个体积的 SVG 几乎必然是数据可视化导出物，不是封面图。 */
export const MAX_SVG_BYTES = 1024 * 1024;

/**
 * 危险模式清单。
 *
 * 每条都写成「在**已解码文本**上做大小写不敏感匹配」，而不是字节匹配：
 * SVG 是 XML，攻击者可以用 `&#x73;cript` 实体编码、`<ScRiPt>` 大小写、
 * `java\tscript:` 插入空白等手法绕过朴素字符串搜索。
 *
 * 因此这里分两步：①先把实体编码与空白折叠掉得到「规范形」；
 * ②在规范形与原文本上都匹配。两步都过才算安全（宁可误拒）。
 */
const DANGEROUS_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  // 脚本执行
  { name: "script 标签", pattern: /<\s*script\b/i },
  { name: "javascript: URL", pattern: /javascript\s*:/i },
  { name: "vbscript: URL", pattern: /vbscript\s*:/i },
  // 事件属性：onload / onerror / onclick / onbegin / onend / onrepeat …
  // 注意 `\bon[a-z]+\s*=` 会误命中 `annotation-xml`？不会 —— 有 `\b` 且要求 `=`。
  // 但会命中 `data-on` 之类自定义属性？不会，`\b` 前是 `-` 不构成词边界，
  // 而 `-` 与 `o` 之间确实不是 `\b`（`-` 是非单词字符，`o` 是单词字符 → 是边界）。
  // 所以这里额外要求属性名前面是空白或引号，避免 `data-onload=` 被误判。
  { name: "事件属性", pattern: /[\s"']on[a-z]{2,}\s*=/i },
  // 外部引用与嵌入
  { name: "iframe", pattern: /<\s*iframe\b/i },
  { name: "embed", pattern: /<\s*embed\b/i },
  { name: "object", pattern: /<\s*object\b/i },
  { name: "foreignObject", pattern: /<\s*foreignObject\b/i },
  // XML 实体（XXE / billion laughs）
  { name: "DOCTYPE 实体声明", pattern: /<!ENTITY\b/i },
  { name: "外部实体 SYSTEM/PUBLIC", pattern: /<!DOCTYPE[^>]*\b(SYSTEM|PUBLIC)\b/i },
  // data: 对 SVG 内引用一律拒绝：`<use href="data:image/svg+xml,...">` 可嵌套脚本
  { name: "data: URL", pattern: /\bdata\s*:/i },
  // CSS 里的 expression()（老 IE，但代价为零）与 @import 外部样式
  { name: "CSS expression()", pattern: /expression\s*\(/i },
  { name: "@import", pattern: /@import\b/i },
];

/**
 * 把 XML 数字实体解码成字符。
 *
 * 只处理 `&#NN;` 与 `&#xHH;` 两种 —— 这是攻击者用来拆散关键字的主要手法
 * （`&#x6a;avascript:` → `javascript:`）。命名实体（`&lt;` 等）不解，
 * 因为解了会制造新的绕过面（`&lt;script&gt;` 本来是安全的文本）。
 */
function decodeNumericEntities(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, body: string) => {
    const code = body[0] === "x" || body[0] === "X"
      ? Number.parseInt(body.slice(1), 16)
      : Number.parseInt(body, 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

/**
 * 把字符引用之间可能插入的空白折叠掉。
 *
 * `java\nscript:` 在 URL 解析里与 `javascript:` 等价（浏览器会剥掉控制字符），
 * 所以检查前必须先归一化。这里只剥 `\t\n\r\f` 与零宽字符，不剥普通空格 ——
 * 剥普通空格会让 `on load=` 之类正常文本误命中，且 URL 里的空格本就非法。
 */
function stripControlChars(text: string): string {
  return text.replace(/[\t\n\r\f\u0000\u200b-\u200f\u2028\u2029\ufeff]/g, "");
}

/** 检查结果。`unsafe` 时 `reason` 会直接展示给上传者。 */
export interface SvgSafetyResult {
  safe: boolean;
  /** 命中的危险模式名（`safe: true` 时为空串）。 */
  reason: string;
}

/**
 * 判断一段 SVG 字节是否安全到可以进对象存储。
 *
 * 调用方（`sniffImage`）在识别出 SVG 后立刻调用它，因此**所有**走
 * `putImage` 的上传都被覆盖，不依赖调用方记得检查。
 */
export function checkSvgSafety(bytes: Uint8Array): SvgSafetyResult {
  if (bytes.length > MAX_SVG_BYTES) {
    return {
      safe: false,
      reason: `SVG 不能大于 ${(MAX_SVG_BYTES / 1024 / 1024).toFixed(0)} MB。`,
    };
  }

  // UTF-16 BOM：浏览器也认，所以必须按 UTF-16 解码后检查，否则整段都是乱码，
  // 所有正则都匹配不到 —— 这是最容易被忽略的绕过路径。
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder("utf-16le", { fatal: false }).decode(bytes);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder("utf-16be", { fatal: false }).decode(bytes);
  } else {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  // ── 归一化顺序很重要，这里是两层防御 ──────────────────────────────
  // 第一层：先剥控制字符，再解数字实体。
  // 第二层：把「剥 + 解」串两遍。
  //
  // 为什么必须两遍 —— 一个真实的绕过路径（实测坐实）：
  // UTF-16LE 编码的 SVG 若被按 UTF-8 解码，每个 ASCII 字符后面都跟着一个
  // NUL（`<` → `<\0`）。此时 `&#x6a;` 里的 `&`/`#`/`x` 之间全是 NUL，
  // 数字实体正则匹配不到；而随后剥掉 NUL 得到的 `&#x6a;avascript:` 是
  // 字面文本，也不匹配 `javascript:`。结果就是 `&#x6a;avascript:` 这条
  // 攻击载荷**直接放行**。
  //
  // 顺序反过来（先解实体再剥控制字符）同样有洞，所以正确做法是两者都做
  // 两遍：第一遍剥掉 NUL 让实体露出真身，第二遍才解得出来。
  // 上面的 UTF-16 BOM 分支是第一道门，但它不能是唯一一道 ——
  // 依赖「只有一个地方负责识别编码」的写法，一旦那个分支被改动就会静默失守。
  const withoutControls = stripControlChars(text);
  const normalized = stripControlChars(decodeNumericEntities(withoutControls));

  for (const { name, pattern } of DANGEROUS_PATTERNS) {
    if (pattern.test(text) || pattern.test(normalized)) {
      return { safe: false, reason: `SVG 里含有不允许的内容：${name}。请改用 PNG/JPEG 或移除该部分。` };
    }
  }

  // 反向检查：必须真的有一个 <svg> 根元素。没有的话它不是 SVG，
  // 而 `sniffImage` 的判断（头部出现 `<svg`）可能被注释里的字符串骗过。
  //
  // 所以这里先剥掉 XML 注释再找根元素：`<!-- <svg> --> 这不是 SVG` 这种
  // 文件浏览器解析会失败（坏图，无 XSS），但把它当 SVG 收下仍然是错的
  // —— 收了就会写进 media 表、拿到公网 URL、在 `<img>` 里变成裂图。
  // 危险模式匹配仍然扫原文（宁可误拒），只有根元素这一条用剥注释后的文本。
  const withoutComments = normalized.replace(/<!--[\s\S]*?-->/g, "");
  if (!/<\s*svg[\s>]/i.test(withoutComments)) {
    return { safe: false, reason: "这不是一个有效的 SVG 文件（找不到 <svg> 根元素）。" };
  }

  return { safe: true, reason: "" };
}
