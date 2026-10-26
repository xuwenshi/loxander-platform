#!/usr/bin/env node
/**
 * 构建产物 CSS 完整性自检。
 *
 * ── 这个脚本为什么存在 ───────────────────────────────────────────────
 * P7 收口时发现：生产构建**成功**、页面**能打开**、HTTP 全部 **200**，
 * 但 CSS 里一条 Tailwind 工具类都没有 —— 整站无样式。
 *
 * 根因是 Tailwind 只接在 `next.config.ts` 的 `turbopack.rules` 里，
 * 而 `scripts/next-local-build.mjs` 用 Webpack 构建，Webpack 路径下
 * 没有任何东西去跑 Tailwind。当时的实测：
 *   `.next/static/css/*.css` 里 `.flex` `.relative` `.overflow-hidden`
 *   `.min-w-*` `.sr-only` 全部零命中，文件只有 9658 字节（全是 @font-face + :root）
 * 而 P7 的 54 条 HTTP 验收全绿 —— 因为它只查状态码、响应头、HTML 字节数。
 *
 * 这类缺陷的可怕之处是**所有常规闸门都不会响**：
 * - tsc 不关心 CSS
 * - 单测跑在 jsdom 里，不做真实布局
 * - HTTP 验收看状态码
 * - 浏览器验收只看 h1 数量与文字长度
 * 只有「量一下 CSS 里有没有那几个类」能抓住它。
 *
 * ── 为什么检查这几个类而不是「CSS 文件大小 > N」──── ─────────────────
 * 大小是脆弱的：改个主题色、加几行自定义 CSS 都能让它变大，而 Tailwind 仍然
 * 可能没跑。所以检查**具体类名是否存在**。选的这几个类覆盖不同机制：
 * - `.flex` / `.grid`       → 布局原子类
 * - `.overflow-hidden`      → 溢出裁剪（正是移动端横向溢出的那个）
 * - `.sr-only`              → 可访问性工具类
 * - `.min-h-svh`            → 带单位/函数的值（`svh` 需要 Tailwind 4 的映射）
 * - `.text-foreground`      → 走 `@theme` 的自定义语义色（证明 @theme 被解析了）
 * 少任何一个都说明 Tailwind 没跑完，而不只是「这次少写了一个类」。
 *
 * ── 退出码 ───────────────────────────────────────────────────────────
 * 0 = 齐全；1 = 缺失（缺哪些会逐条打印）。可以直接接在 build 之后当闸门。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const CSS_DIR = path.join(REPO_ROOT, "apps", "web", ".next", "static", "css");

/**
 * 必须存在的工具类（转义后的 CSS 选择器形态）。
 *
 * 写成 `.xxx{` 而不是 `.xxx`：Tailwind 产出的原子类几乎都是 `.flex{...}`，
 * 带左花括号能避免把 `.flex-col` 之类的前缀误判成 `.flex`。
 */
const REQUIRED_CLASSES = [
  ".flex{",
  ".grid{",
  ".overflow-hidden{",
  ".sr-only{",
  ".min-h-svh{",
  ".text-foreground{",
];

/** 低于这个字节数基本可以断定 Tailwind 没跑（正常产物 70KB 量级）。 */
const MIN_EXPECTED_BYTES = 30_000;

function fail(message) {
  console.error(`[check-css] ✗ ${message}`);
  process.exitCode = 1;
}

function main() {
  // 目录不存在通常意味着「还没构建」。这不是缺陷，但也不能算通过 ——
  // 静默返回 0 会让 CI 里「构建步骤被跳过」看起来像「自检通过」。
  let entries;
  try {
    if (!statSync(CSS_DIR).isDirectory()) throw new Error("not a directory");
    entries = readdirSync(CSS_DIR).filter((name) => name.endsWith(".css"));
  } catch {
    fail(`找不到 CSS 产物目录：${CSS_DIR}\n         先跑 npm run build:web:local，或确认构建真的产出了 CSS。`);
    return;
  }

  if (entries.length === 0) {
    fail(`CSS 产物目录是空的：${CSS_DIR}`);
    return;
  }

  // 把所有 CSS 拼起来查：Tailwind 可能按路由切成多个文件，
  // 关键类落在哪个文件里不重要，重要的是整站产物里得有。
  let all = "";
  let totalBytes = 0;
  for (const name of entries) {
    const full = path.join(CSS_DIR, name);
    const text = readFileSync(full, "utf8");
    totalBytes += text.length;
    all += text;
  }

  const missing = REQUIRED_CLASSES.filter((cls) => !all.includes(cls));

  if (missing.length > 0) {
    fail(
      `CSS 产物里缺少 ${missing.length} 个关键工具类：${missing.join(" ")}\n` +
        `         产物：${entries.length} 个文件 / ${totalBytes} 字节\n` +
        `         这几乎一定是 Tailwind 没跑。检查：\n` +
        `           ① apps/web/postcss.config.mjs 是否还在（Webpack 路径靠它）\n` +
        `           ② next.config.ts 的 turbopack.rules 是否还在（Turbopack 路径靠它）\n` +
        `           ③ scripts/next-local-build.mjs 用的是哪个 bundler\n` +
        `         注意：这个缺陷下页面**能打开**、HTTP **全 200**，只有这条自检会响。`,
    );
    return;
  }

  if (totalBytes < MIN_EXPECTED_BYTES) {
    fail(
      `CSS 产物只有 ${totalBytes} 字节（低于 ${MIN_EXPECTED_BYTES}）—— 关键类都在但总量异常小，` +
        `可能 Tailwind 只扫了部分源码。产物：${entries.join(", ")}`,
    );
    return;
  }

  console.log(
    `[check-css] ✓ ${entries.length} 个 CSS 文件 / ${totalBytes} 字节，` +
      `${REQUIRED_CLASSES.length} 个关键工具类齐全`,
  );
}

main();
