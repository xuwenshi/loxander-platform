/**
 * SVG 上传安全测试（方案 §13.3「拒绝 SVG 中的脚本」）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 * P6 闸门矩阵报告确认：`sniffImage|MAX_IMAGE_BYTES|uploadMediaAction` 在所有
 * 测试里**零命中**，也就是说「拒绝 SVG 中的脚本」这条安全要求当时根本没实现，
 * 也没有任何断言守着它。补上实现后必须同时补上「有人把它改坏会变红」的断言，
 * 否则就又是一条空转的闸门。
 *
 * ── 测试策略：三条腿 ──────────────────────────────────────────────────
 * ① **正向**：仓库里现有的 SVG 封面必须全部通过 —— 防止「安全策略太严把
 *    正常图片也拒了」这种更容易被忽略的回归（作者手写的封面是真实资产）。
 * ② **反向**：攻击载荷必须全部拒绝。清单覆盖 SVG 规范里所有能执行脚本的位置，
 *    不是随手写几个 `<script>` 就算完。
 * ③ **绕过路径**：编码（UTF-16 BOM / 数字实体）、位置（4 KB 之后）、
 *    伪装（注释里写 `<svg>`）三类最容易漏的手法单独测。
 *
 * ── 为什么用 node:test 而不是 vitest ──────────────────────────────────
 * 本机沙箱禁子进程（`spawn EPERM`），vitest 起 worker 会失败；项目里所有
 * 测试都是 `node --test-isolation=none`。`svg-safety.ts` 与 `image-info.ts`
 * 都是纯函数、不 import `server-only` / `next/cache`，所以不需要 registerHooks
 * 打桩 —— 但 `image-info.ts` 用无扩展名相对导入引 `./svg-safety`，
 * 所以仍然要补一个 `.ts` 后缀解析器（见下面 resolve hook）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 本文件在 `apps/web/src/lib/media/__tests__/`，向上四层到 `apps/web`。 */
const WEB_ROOT = resolvePath(HERE, "..", "..", "..", "..");
const SRC = join(WEB_ROOT, "src");

// Node 原生不认「无扩展名的 TS 相对导入」，而项目源码统一省略 `.ts`。
// 只补后缀，不改语义：找不到候选就让 Node 自己报错，不要吞掉。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) && context.parentURL !== undefined) {
      const base = dirname(fileURLToPath(context.parentURL));
      const target = resolvePath(base, specifier);
      for (const suffix of [".ts", ".tsx", "/index.ts"]) {
        try {
          statSync(target + suffix);
          return { url: pathToFileURL(target + suffix).href, shortCircuit: true };
        } catch {
          // 继续试下一个后缀
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const svgSafety = await import(pathToFileURL(join(SRC, "lib", "media", "svg-safety.ts")).href);
const imageInfo = await import(pathToFileURL(join(SRC, "lib", "media", "image-info.ts")).href);

const checkSvgSafety = svgSafety.checkSvgSafety as (bytes: Uint8Array) => {
  safe: boolean;
  reason: string;
};
const MAX_SVG_BYTES = svgSafety.MAX_SVG_BYTES as number;
const sniffImage = imageInfo.sniffImage as (bytes: Uint8Array) => {
  mimeType: string;
  width?: number;
  height?: number;
};
const UnsupportedImageError = imageInfo.UnsupportedImageError as new (m: string) => Error;

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
/** 包一层合法的 svg 根元素，让测试只关心内部那段危险内容。 */
const withRoot = (inner: string): Uint8Array =>
  enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`);

/* ────────────────────────────────────────────────────────────────────── */
/* ① 正向：仓库里现有的 SVG 封面必须全部通过                              */
/* ────────────────────────────────────────────────────────────────────── */

test("现有 SVG 封面全部通过安全检查（安全策略不许误伤真实资产）", () => {
  const imagesDir = join(WEB_ROOT, "public", "images");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith(".svg")) files.push(full);
    }
  };
  walk(imagesDir);

  // 目录里至少要有封面 —— 如果哪天有人把图挪走了，这条会提醒而不是静默通过。
  assert.ok(files.length > 0, `public/images 下应当有 SVG 封面，实际找到 ${files.length} 个`);

  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file));
    const result = checkSvgSafety(bytes);
    assert.equal(
      result.safe,
      true,
      `${file} 是作者手写的正常封面，不应被拒绝：${result.reason}`,
    );
    // 顺带验证 sniffImage 也认它，否则上传链路第一步就会失败。
    const info = sniffImage(bytes);
    assert.equal(info.mimeType, "image/svg+xml", `${file} 应被识别为 SVG`);
  }
});

/* ────────────────────────────────────────────────────────────────────── */
/* ② 反向：攻击载荷必须全部拒绝                                           */
/* ────────────────────────────────────────────────────────────────────── */

test("SVG 里的脚本与危险引用全部被拒绝", () => {
  const cases: ReadonlyArray<readonly [label: string, bytes: Uint8Array]> = [
    // 脚本执行
    ["script 标签", withRoot("<script>alert(1)</script>")],
    ["script 大小写混写", withRoot("<ScRiPt>alert(1)</ScRiPt>")],
    ["script 带 type 属性", withRoot('<script type="text/javascript">x</script>')],
    // 事件属性
    ["根元素 onload", enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')],
    ["子元素 onerror", withRoot('<image href="x" onerror="alert(1)"/>')],
    // 危险协议
    ["javascript: href", withRoot('<a href="javascript:alert(1)"><text>x</text></a>')],
    ["javascript: 大写", withRoot('<a href="JavaScript:alert(1)"><text>x</text></a>')],
    ["vbscript:", withRoot('<a href="vbscript:msgbox(1)"><text>x</text></a>')],
    // 外部嵌入
    ["iframe", withRoot('<iframe src="https://evil.example"></iframe>')],
    ["embed", withRoot('<embed src="x.swf"/>')],
    ["object", withRoot('<object data="x.swf"></object>')],
    ["foreignObject 内嵌 HTML", withRoot("<foreignObject><body>x</body></foreignObject>")],
    // XML 实体（XXE / billion laughs）
    [
      "DOCTYPE ENTITY（XXE）",
      enc(
        '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
          '<svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>',
      ),
    ],
    [
      "DOCTYPE PUBLIC 外部实体",
      enc('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://evil/x.dtd">' +
        '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ],
    // data: 可嵌套脚本
    ["data: URL", withRoot('<image href="data:image/svg+xml;base64,PHNjcmlwdD4="/>')],
    ["<use href=data:>", withRoot('<use href="data:image/svg+xml,%3Cscript%3E"/>')],
    // CSS
    ["CSS expression()", withRoot('<rect style="width:expression(alert(1))"/>')],
    ["@import 外部样式", withRoot('<style>@import url("https://evil/x.css");</style>')],
  ];

  const leaked: string[] = [];
  for (const [label, bytes] of cases) {
    const result = checkSvgSafety(bytes);
    if (result.safe) leaked.push(label);
    // 拒绝时必须给出可读原因（会直接展示给上传者），不能是空串。
    else assert.notEqual(result.reason, "", `${label} 被拒绝但没给原因`);
  }
  assert.deepEqual(leaked, [], `以下攻击载荷被放行了：${leaked.join("、")}`);
});

/* ────────────────────────────────────────────────────────────────────── */
/* ③ 绕过路径：编码 / 位置 / 伪装                                          */
/* ────────────────────────────────────────────────────────────────────── */

test("数字实体编码的 javascript: 被拒绝（拆散关键字的手法）", () => {
  const cases: ReadonlyArray<readonly [label: string, inner: string]> = [
    ["十六进制实体", '<a href="&#x6a;avascript:alert(1)"><text>x</text></a>'],
    ["十进制实体", '<a href="&#106;avascript:alert(1)"><text>x</text></a>'],
    ["换行拆分", '<a href="java\nscript:alert(1)"><text>x</text></a>'],
    ["制表符拆分", '<a href="java\tscript:alert(1)"><text>x</text></a>'],
  ];
  for (const [label, inner] of cases) {
    const result = checkSvgSafety(withRoot(inner));
    assert.equal(result.safe, false, `${label} 应当被拒绝（实体/空白归一化后仍是 javascript:）`);
  }
});

test("UTF-16 BOM 编码的 SVG 也按 UTF-16 解码后检查", () => {
  // 这是最容易被忽略的绕过路径：如果只按 UTF-8 解码，整段都是乱码，
  // 所有正则都匹配不到，恶意 SVG 会直接通过。
  const payload = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const body = Buffer.from(payload, "utf16le");

  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  assert.equal(checkSvgSafety(new Uint8Array(le)).safe, false, "UTF-16LE 应被拒绝");

  const beBody = Buffer.from(body);
  beBody.swap16();
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
  assert.equal(checkSvgSafety(new Uint8Array(be)).safe, false, "UTF-16BE 应被拒绝");
});

test("UTF-16 + 数字实体：两层防御必须都成立（只靠 BOM 分支会静默失守）", () => {
  // 这条用例是被一次「变异存活」逼出来的，值得单独记一笔：
  //
  // 上一条测试（明文 `<script>`）在**删掉 UTF-16 分支、一律按 UTF-8 解码**之后
  // 依然全绿 —— 因为按 UTF-8 解出来是 `< \0 s \0 c \0 ...`，
  // `stripControlChars` 剥掉 NUL 之后正好还原成 `<script>`，正则照样命中。
  // 也就是说：上一条测试只证明了「最终能拒绝」，没证明「BOM 分支是必要的」，
  // 它咬不住那个分支。
  //
  // 真正依赖 BOM 分支的是**数字实体**形态：UTF-16 被误按 UTF-8 解码时，
  // `&#x6a;` 里的 `&`/`#`/`x` 之间都夹着 NUL，实体正则匹配不到；
  // 之后剥掉 NUL 得到的是字面文本 `&#x6a;avascript:`，也不匹配 `javascript:`。
  // 两层都漏 → 载荷放行。实测确认过这个绕过路径真实存在。
  //
  // 现在 `checkSvgSafety` 用「剥控制字符 → 解实体 → 再剥 → 再解」两遍归一化，
  // 即使 BOM 分支哪天被改坏，第二遍仍能抓住它。这条用例同时守住两道门。
  const payload =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    '<a href="&#x6a;avascript:alert(1)"><text>x</text></a></svg>';

  // 先证明明文形态会被拒（基线，说明载荷本身是有效的）
  assert.equal(checkSvgSafety(enc(payload)).safe, false, "明文数字实体形态应被拒绝");

  const le = new Uint8Array(
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(payload, "utf16le")]),
  );
  assert.equal(checkSvgSafety(le).safe, false, "UTF-16LE + 数字实体应被拒绝（不能被 NUL 拆散）");

  const beBody = Buffer.from(payload, "utf16le");
  beBody.swap16();
  const be = new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]));
  assert.equal(checkSvgSafety(be).safe, false, "UTF-16BE + 数字实体应被拒绝");
});

test("危险内容藏在 4 KB 之后仍被拒绝（证明检查全部字节）", () => {
  // 尺寸可以只读头部，安全检查不能截断 —— 把 <script> 放在第 5001 字节
  // 就能绕过「只看前 4 KB」的实现。这是本函数与 image-info.ts 的关键差别。
  const padding = "<!-- " + "x".repeat(6000) + " -->";
  const evil = enc(`<svg xmlns="http://www.w3.org/2000/svg">${padding}<script>alert(1)</script></svg>`);
  assert.ok(evil.length > 4096, "样本必须真的超过 4 KB，否则这条测试没有意义");
  assert.equal(checkSvgSafety(evil).safe, false, "深埋的脚本应被拒绝");

  // 对照：同一位置换成安全内容必须通过，证明上一条不是「大文件一律拒绝」。
  const safe = enc(`<svg xmlns="http://www.w3.org/2000/svg">${padding}<rect width="1" height="1"/></svg>`);
  assert.equal(checkSvgSafety(safe).safe, true, "深埋但安全的内容应通过");
});

test("注释里提到 <svg> 的文本不算有效 SVG", () => {
  // 剥注释后再找根元素：浏览器解析这种文件会失败（坏图、无 XSS），
  // 但把它当 SVG 收下仍然是错的 —— 会写进 media 表、拿到公网 URL、变成裂图。
  const result = checkSvgSafety(enc("<!-- <svg> --> 这不是 SVG"));
  assert.equal(result.safe, false, "只有注释里出现 <svg> 不应被当作 SVG");
});

test("超过体积上限的 SVG 被拒绝", () => {
  const huge = new Uint8Array(MAX_SVG_BYTES + 1);
  huge.set(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  const result = checkSvgSafety(huge);
  assert.equal(result.safe, false);
  assert.match(result.reason, /MB/, "拒绝原因应说明体积上限");
});

test("端到端：恶意 SVG 走 sniffImage 直接抛 UnsupportedImageError", () => {
  // 安全检查必须挂在 sniffImage 里而不是靠调用方记得调 —— 这样所有走
  // putImage 的上传都被覆盖。这条测试守的就是「挂载位置」这件事。
  assert.throws(
    () => sniffImage(withRoot("<script>alert(1)</script>")),
    (error: unknown) => error instanceof UnsupportedImageError,
    "恶意 SVG 应在识别阶段就被拒绝",
  );
});
