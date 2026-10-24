/**
 * P6-A 离线可访问性 / 移动端 / 暗色模式审计套件。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 一、为什么是「扫源码」而不是「断言 DOM」
 * ════════════════════════════════════════════════════════════════════════════
 * 方案 §11 P6 要求「移动端 + 暗色模式 + 可访问性」跑一遍验收。业界标准做法是
 * Playwright + axe-core 打真实页面。本机做不到，原因是硬性的（不是没时间写）：
 *
 *   ① `node_modules` 里没有 `playwright` / `@playwright/test` / `lighthouse`
 *      （task-16 已核实），且本任务禁止 `npm install` —— 装也装不上。
 *   ② 本机沙箱**禁止 fork 子进程**（`spawn EPERM`，见执行记录 §6.3）。
 *      `next build` / `next dev` / `vitest` 全部起不来；即使装上 Playwright，
 *      它启动浏览器的第一件事就是 fork 一个 chromium 进程，同样 EPERM。
 *   ③ 即便前两条都绕过，Playwright 也需要一个**运行中的服务端**才能访问页面。
 *
 * 所以本套件退一步：**对渲染这些 DOM 的源码做静态审计**。它能证明的事情是
 * 「生成这段 DOM 的代码符合规则」，不能证明的事情是「浏览器里算出来的对比度、
 * 实际命中区域像素、真实焦点顺序」。这个边界必须在报告里写清楚，不许把
 * 「扫源码通过」说成「可访问性验收通过」。
 *
 * 静态审计的另一个好处：它是**回归守卫**。有人新加一个只有图标的按钮、或从
 * `globals.css` 删掉一个 `--color-*` 映射，测试立刻红 —— 这是 axe 做不到的
 * （axe 只在跑的那一版页面上生效）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 二、八条检查与 WCAG 2.2 的对应关系
 * ════════════════════════════════════════════════════════════════════════════
 *   W1  <img> 必须有 alt ................. 1.1.1 非文本内容（A）
 *   W2  标题层级：h1 至多一个、不跳级 ...... 1.3.1 信息和关系（A）
 *   W3  <a>/<button> 必须有可访问名 ....... 4.1.2 名称、角色、值（A）+ 2.4.4 链接目的（A）
 *   W4  禁止硬编码颜色（暗色下会失效）..... 1.4.3 对比度（AA）+ 1.4.11 非文本对比度（AA）
 *   W5  `@theme inline` 覆盖 :root 短名 ... 1.4.3 的**前置条件**：色值没被映射成
 *        工具类时，`text-muted-deep` 这类写法不报错也不产出 CSS，结果是
 *        「继承了父级颜色」。这正是 P5 修过的两个缺陷，本检查是它们的回归守卫。
 *   W6  触控命中区域 ≥ 44px .............. 2.5.5 目标尺寸（AAA，但方案按 AA 的
 *        等效要求执行，App 侧普遍 44px）
 *   W7  <html lang> + 跳转链接锚点存在 .... 3.1.1 页面语言（A）+ 2.4.1 绕过区块（A）
 *   W8  表单控件有 label .................. 1.3.1 + 3.3.2 标签或说明（A）+ 4.1.2
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 三、扫描方法上的三个关键决定（都踩过坑，不要「优化」掉）
 * ════════════════════════════════════════════════════════════════════════════
 *   ① **必须先剥注释再扫描。**
 *      第一版直接对原文跑 `<img\b[^>]*>`，在 `components/admin/media-grid.tsx`
 *      报了两个假阳性 —— 那是 :24 与 :29 两行**注释**里写的 `<img>` 与 `<img>`
 *      字样。这个文件真正的那张图在 :89，`alt={row.alt}` 是有的。
 *      同理 `app/admin/settings/page.tsx:193` 的 `#7c879b` 出现在注释里。
 *      所以 W1 / W3 / W4 / W8 全部先过 `stripComments()`。
 *   ② **W2 要做一层组件展开。**
 *      22 个 `page.tsx` 里有一半自己**不写** `<h1>`：它们用
 *      `components/cosmic/SectionIntro.tsx:47` 的 `<h1>`。只数页面文件会得出
 *      「11 个页面没有 h1」的错误结论。所以 W2 把每个页面 import 的**本地组件**
 *      展开一层，再统计标题层级。
 *   ③ **`<a>` 的可访问名不能只看文字。**
 *      `CosmicLink` / `next/link` 渲染的也是 `<a>`，但源码里写的是
 *      `<CosmicLink>文本</CosmicLink>`。W3 对 `Link` / `CosmicLink` 一起扫，
 *      判据是「开始标签里有 aria-label，或闭合标签之间还有非标签字符」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 四、allowlist 的形状：允许「已知缺陷」，但不允许「缺陷被悄悄豁免」
 * ════════════════════════════════════════════════════════════════════════════
 * 本机现有代码里确实存在几条不符合规则的地方（见 `KNOWN_*` 常量）。任务书要求
 * 「发现真实缺陷不要改业务代码，列进报告」。为了既能交付一个**当前全绿**的套件、
 * 又不把缺陷藏起来，三个 allowlist 都采用同一套双向断言：
 *
 *   · 正向：**不在** allowlist 里的违规 → 测试失败（新违规立刻被拦住）。
 *   · 反向：allowlist 里的条目**必须仍然是违规** → 否则测试失败（修好之后
 *     必须回来删条目，防止 allowlist 腐败成「永久的免死金牌」）。
 *
 * 每一条 allowlist 都写了理由。没有理由的条目不允许存在（下面有断言检查）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 五、运行方式
 * ════════════════════════════════════════════════════════════════════════════
 *   node --test-isolation=none apps/web/src/lib/__tests__/a11y-audit.test.ts
 *
 * 必须带 `--test-isolation=none`：本机沙箱禁止 fork 子进程，默认的
 * 「每个测试文件一个子进程」会 `spawn EPERM`（执行记录 §6.3）。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/* -------------------------------------------------------------------------- */
/* 路径：从 cwd 往上找仓库根，绝不硬编码盘符                                     */
/* -------------------------------------------------------------------------- */

/**
 * 从 `start` 起向上最多 8 层，找到同时含 `apps/web/src` 与 `db/schema.ts` 的目录。
 * 两个特征一起用：只认 `apps/web/src` 的话，如果测试被别处的同名目录骗到会出错。
 */
function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const looksLikeRepo =
      existsSync(path.join(dir, "apps", "web", "src")) &&
      existsSync(path.join(dir, "apps", "web", "package.json"));
    if (looksLikeRepo) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `[a11y-audit] 从 ${start} 向上 8 层没找到仓库根（判据：apps/web/src + apps/web/package.json）。`,
  );
}

const REPO_ROOT = findRepoRoot(process.cwd());
const WEB_ROOT = path.join(REPO_ROOT, "apps", "web");
const SRC_ROOT = path.join(WEB_ROOT, "src");
const APP_ROOT = path.join(SRC_ROOT, "app");
const GLOBALS_CSS = path.join(APP_ROOT, "globals.css");

/** 相对仓库根的 posix 路径。报告里全部用这个形态，方便和 `git diff` 对照。 */
function rel(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join("/");
}

function read(abs: string): string {
  return readFileSync(abs, "utf8");
}

/** 递归列出目录下所有文件；`skipDirs` 里的目录整棵跳过。 */
function walkDir(dir: string, skipDirs: readonly string[] = []): string[] {
  const out: string[] = [];
  // 显式声明为 `Dirent[]`（不带泛型参数）：Node 24 的类型里 readdirSync 有多个
  // 重载，`withFileTypes: true` 会推断出 `Dirent<NonSharedBuffer>`，直接写
  // `ReturnType<typeof readdirSync>` 反而会拿到联合类型并报 TS2322。
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue;
      out.push(...walkDir(abs, skipDirs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * 全部待扫的 `.ts` / `.tsx`。**排除 `__tests__`**：那里有刻意构造的坏样本
 * （例如 `admin-actions.test.ts:307` 的 Shiki 输出里带 `#0550ae` 色值），
 * 扫进来会产生一堆与产品代码无关的噪音。
 */
const SOURCE_FILES: readonly string[] = walkDir(SRC_ROOT, ["node_modules", "__tests__"])
  .filter((abs) => /\.(ts|tsx)$/.test(abs))
  .sort();

const TSX_FILES: readonly string[] = SOURCE_FILES.filter((abs) => abs.endsWith(".tsx"));

/* -------------------------------------------------------------------------- */
/* 剥注释：W1 / W3 / W4 / W8 的公共前置                                          */
/* -------------------------------------------------------------------------- */

/**
 * 把 TSX/TS 源码里的注释替换成等长空白（保留换行，行号不漂），返回剥离后的文本。
 *
 * 为什么要等长替换：所有断言都要报 `文件:行号`，如果直接删掉注释，
 * 后面所有行号都会错位。用空白填充能同时满足「不含注释内容」和「行号正确」。
 *
 * 覆盖三种形态：
 *   · `{/* ... *\/}`  JSX 表达式容器里的注释
 *   · `/* ... *\/`    块注释
 *   · `// ...`         行注释
 *
 * 已知局限（写在这里防止后人误以为它很聪明）：正则剥注释对**字符串字面量里
 * 出现的 `//` 或 `/*`** 会误判。本仓库里没有这种写法；真遇到就换成真正的
 * 词法扫描。这里的取舍是「够用 + 可读」压过「严格正确」。
 */
function stripComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (whole, lead: string) => lead + blank(whole.slice(lead.length)));
}

/** 剥注释后按行切分。 */
function strippedLines(abs: string): string[] {
  return stripComments(read(abs)).split(/\r?\n/);
}

/* -------------------------------------------------------------------------- */
/* 找开标签的结束位置（W3 / W6 的公共前置，必须用它，不能用 indexOf(">")）        */
/* -------------------------------------------------------------------------- */

/**
 * 找到从 `startIndex` 起的开标签真正的结束位置（`>` 的下标），返回 -1 表示没找到。
 *
 * ══ 为什么不能直接 `indexOf(">")`（第一版就是这个错，被测试自己抓出来）══
 * 本项目的事件处理器几乎全是箭头函数：
 *
 *     <button onClick={() => setOpen((value) => !value)} aria-label="打开菜单" …>
 *                        ↑ 这个 `=>` 里的 `>` 就是第一个 `>`
 *
 * 朴素实现会把「开标签」截断到 `onClick={() =` 为止，于是 `aria-label`、
 * `className` 全被判定为「标签外」。后果是**误报而不是漏报**：
 *   · W3c 报「Navigation 与 admin-chrome 的图标按钮都没 aria-label」（实际都有）。
 *   · W6 报这些元素「无可读 className」（实际 className 写在后面几行）。
 * 误报比漏报更危险 —— 它会诱使人去「修」本来正确的代码。
 *
 * 正确做法：扫描字符时跳过 `{…}` 表达式（含嵌套与括号深度）与字符串字面量，
 * 只把**花括号深度为 0** 时遇到的 `>` 当标签结束。
 */
function findOpenTagEnd(source: string, startIndex: number): number {
  let braceDepth = 0;
  let quote: '"' | "'" | "`" | null = null;

  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];

    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      continue;
    }
    if (ch === ">" && braceDepth === 0) return i;
  }

  return -1;
}

/* -------------------------------------------------------------------------- */
/* W1 · <img> 必须有 alt                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 找出一处 `<img ...>` 开标签的完整文本。`[^>]*` 会在 `src={a > b}` 这种写法上
 * 提前截断，但本项目没有这种写法；用非贪婪 + 允许换行足够。
 */
function findImgTags(source: string): { index: number; tag: string }[] {
  const out: { index: number; tag: string }[] = [];
  const re = /<img\b[\s\S]*?\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out.push({ index: match.index, tag: match[0] });
  }
  return out;
}

test("W1：全部 <img> 都显式写了 alt（允许 alt=\"\"，但必须显式）", () => {
  const violations: string[] = [];
  let total = 0;

  for (const abs of TSX_FILES) {
    const lines = strippedLines(abs).join("\n");
    for (const { index, tag } of findImgTags(lines)) {
      total += 1;
      const hasAlt = /\balt\s*=/.test(tag);
      if (!hasAlt) {
        const line = lines.slice(0, index).split("\n").length;
        violations.push(`${rel(abs)}:${line} :: ${tag.replace(/\s+/g, " ").trim()}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `有 <img> 缺 alt（装饰性图片请显式写 alt=""）：\n${violations.join("\n")}`,
  );
  assert.ok(total >= 2, `只扫到 ${total} 个 <img>，预期至少 2 个（media-grid + admin-chrome 头像）`);
});

test("W1b：剥注释是必须的 —— 注释里的 <img> 字样不能被当成真标签", () => {
  // 这条测试本身就是 W1 方法的回归守卫。media-grid.tsx 的注释里写了两次 `<img>`，
  // 如果将来有人把 stripComments() 删掉，W1 会凭空多出两个假阳性。
  const mediaGrid = path.join(SRC_ROOT, "components", "admin", "media-grid.tsx");
  const raw = read(mediaGrid);

  assert.ok(
    raw.includes("<img> 而不是 next/image"),
    "media-grid.tsx 的注释里本该有 `<img>` 字样（这条测试的前提变了，请更新它）",
  );

  const rawTags = findImgTags(raw).length;
  const strippedTags = findImgTags(stripComments(raw)).length;
  assert.ok(
    rawTags > strippedTags,
    `剥注释后 <img> 数量应减少（原文 ${rawTags}，剥后 ${strippedTags}）`,
  );
  assert.equal(strippedTags, 1, "media-grid.tsx 剥注释后应恰好剩 1 个真 <img>");
});

/* -------------------------------------------------------------------------- */
/* W2 · 标题层级：h1 至多一个、不跳级                                            */
/* -------------------------------------------------------------------------- */

/** 页面级的已知例外。每一条都必须能通过反向断言（即它确实仍然违规）。 */
const HEADING_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    "apps/web/src/app/admin/page.tsx",
    "同一个文件里有两个互斥分支各自的 <h1>：DashboardBody（:65，正常总览）与 " +
      "MissingDatabase（:202，没配 DATABASE_URL 时的落地页）。两者永不共存于同一 DOM，" +
      "静态扫描却只能数到 2。拆成两个文件可以消除这条豁免，但会为一个纯静态审计规则" +
      "引入一个只为测试服务的文件边界，不划算。",
  ],
]);

/**
 * 展开一个页面文件「会渲染出来的标题层级」。
 *
 * 做法：页面自身的 `<hN>` + 它 import 的**本地组件**里的 `<hN>`，只展开一层。
 * 一层足够，因为本项目所有「渲染标题的公共组件」都是叶子组件
 * （SectionIntro→h1、SectionHeading→h2、PostCard/ProjectCard→h3、PostToc→h2）。
 * 更深的情况（PostList → PostCard）会漏掉 h3，但遗漏只会让「跳级」检查**更宽松**
 * 而不会误报，所以是安全的方向；标题集合的连续性仍有页面自己的 sr-only 标题兜住。
 */
function collectHeadingLevels(pageAbs: string): number[] {
  const levels: number[] = [];

  const harvest = (source: string): void => {
    for (const match of stripComments(source).matchAll(/<h([1-6])\b/g)) {
      levels.push(Number(match[1]));
    }
  };

  const pageSource = read(pageAbs);
  harvest(pageSource);

  for (const spec of localImportSpecs(pageSource)) {
    const resolved = resolveLocalModule(pageAbs, spec);
    if (resolved === null) continue;
    if (!resolved.endsWith(".tsx")) continue;
    harvest(read(resolved));
  }

  return levels;
}

/** 抓出所有 import 的模块说明符（只关心 `@/` 与相对路径，第三方包直接过滤掉）。 */
function localImportSpecs(source: string): string[] {
  const specs: string[] = [];
  const re = /from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const spec = match[1];
    if (spec.startsWith("@/") || spec.startsWith("./") || spec.startsWith("../")) {
      specs.push(spec);
    }
  }
  return specs;
}

/** 把一个 import 说明符解析成绝对文件路径；解析不出来返回 null。 */
function resolveLocalModule(fromAbs: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? path.join(SRC_ROOT, spec.slice(2))
    : path.resolve(path.dirname(fromAbs), spec);

  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 层级是否连续（从最小值到最大值之间没有缺口）。集合视角，不依赖出现顺序。 */
function firstLevelGap(levels: readonly number[]): { from: number; to: number } | null {
  const unique = [...new Set(levels)].sort((a, b) => a - b);
  for (let i = 1; i < unique.length; i += 1) {
    if (unique[i] - unique[i - 1] > 1) {
      return { from: unique[i - 1], to: unique[i] };
    }
  }
  return null;
}

function pageFiles(): string[] {
  return walkDir(APP_ROOT, ["node_modules"])
    .filter((abs) => abs.endsWith("page.tsx"))
    .sort();
}

test("W2：每个页面恰好一个 h1（展开公共组件后统计）", () => {
  const violations: string[] = [];
  const allowlisted: string[] = [];

  for (const abs of pageFiles()) {
    const levels = collectHeadingLevels(abs);
    const h1Count = levels.filter((level) => level === 1).length;
    const key = rel(abs);

    if (h1Count === 1) continue;

    const reason = HEADING_ALLOWLIST.get(key);
    if (reason !== undefined) {
      allowlisted.push(key);
      continue;
    }
    violations.push(`${key} :: h1 数量 = ${h1Count}（层级 ${JSON.stringify(levels)}）`);
  }

  assert.deepEqual(violations, [], `页面 h1 数量不为 1 且不在 allowlist：\n${violations.join("\n")}`);

  // 反向断言：allowlist 里的每一条都必须仍然是例外，否则条目该删了。
  for (const [key, reason] of HEADING_ALLOWLIST) {
    assert.ok(reason.trim().length > 0, `W2 allowlist 条目缺理由：${key}`);
    assert.ok(
      allowlisted.includes(key),
      `W2 allowlist 里的 ${key} 现在已经不是例外了 —— 请删掉这条豁免（否则它会永久掩盖未来的真违规）`,
    );
  }
});

test("W2b：页面内标题层级不跳级（集合连续，例如 {1,2,3} 合法、{1,3} 非法）", () => {
  const violations: string[] = [];

  for (const abs of pageFiles()) {
    const gap = firstLevelGap(collectHeadingLevels(abs));
    if (gap !== null) {
      violations.push(`${rel(abs)} :: h${gap.from} 之后直接到 h${gap.to}，缺一层`);
    }
  }

  assert.deepEqual(violations, [], `标题跳级：\n${violations.join("\n")}`);
});

test("W2c：列表页补齐 sr-only 的 h2 是有意为之（记录这个事实，防止被当成冗余删掉）", () => {
  // （site)/blog/page.tsx:34-37 有一段注释解释：页头是 h1、卡片标题是 h3，
  // 必须补一层 sr-only 的 h2 才能让读屏按层级跳读。这条测试把那个约定钉住。
  const blogPage = path.join(APP_ROOT, "(site)", "blog", "page.tsx");
  const source = read(blogPage);
  assert.ok(
    /<h2[^>]*className="[^"]*\bsr-only\b/.test(source),
    "(site)/blog/page.tsx 缺少 sr-only 的 h2 —— 删掉它会让 h1 → h3 跳级",
  );
});

/* -------------------------------------------------------------------------- */
/* W3 · <a> / <button> 必须有可访问名                                           */
/* -------------------------------------------------------------------------- */

/** 开标签里是否已经提供了可访问名。 */
function hasExplicitName(openTag: string): boolean {
  return /\baria-label\s*=/.test(openTag) || /\baria-labelledby\s*=/.test(openTag);
}

/**
 * 把 props 整个 spread 出去的**包装组件**：源码里看不到 label，但它会把调用方
 * 传进来的 `children` / `aria-label` 原样转手，静态扫描因此无从判断。
 *
 * 这是「无法静态判定」，不是「违规」。区别很重要：违规必须修，无法判定只需要
 * 登记 + 由下面那条计数断言盯住数量，一旦变多就提醒人工复核。
 */
const SPREAD_PASSTHROUGH: ReadonlyMap<string, string> = new Map([
  [
    "apps/web/src/components/cosmic/CosmicLink.tsx",
    "CosmicLink 是对 next/link 的包装：`<Link {...rest} …>` 把 children 与 " +
      "aria-* 原样转发。它自己的可访问名由 22 处调用点决定，那些调用点都写了文本子节点，" +
      "已由 W3 逐个覆盖。这一处在源码层面无法静态判定。",
  ],
]);

/**
 * 元素的子内容是否提供了可读文字（决定它算「有文本」还是「纯图标」）。
 *
 * ══ 为什么不能只做 `inner.replace(/<[^>]*>/g, "")`（第一版就是这个错）══
 * 本项目所有图标按钮的子内容都是**JSX 表达式**：
 *
 *     {open ? <CloseIcon width={18} height={18} /> : <MenuIcon width={18} height={18} />}
 *
 * 朴素实现先剥标签，剩下 `{open ?  : }` —— 里面有字母 `open`，于是被判成
 * 「有文本」。结果 W3c 报「实际只找到 0 个图标按钮」，而事实上两个图标按钮
 * 都写了 aria-label、都符合要求。又是误报。
 *
 * 正确判据：逐个处理**花括号表达式**：
 *   · 表达式里含 JSX 元素（有 `<`）→ 它渲染的是图标，不贡献文字；
 *   · 表达式里没有 JSX（`{link.label}`、`{item.title}`）→ 它渲染的是字符串，
 *     算贡献文字。
 * 表达式之外的部分（花括号外）才是真正的静态文本。
 */
function hasInnerText(inner: string): boolean {
  let outsideBraces = "";

  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "{") {
      outsideBraces += inner[i];
      continue;
    }

    // 花括号配对，取出整个表达式的内容。
    let depth = 0;
    let end = i;
    for (let j = i; j < inner.length; j += 1) {
      if (inner[j] === "{") depth += 1;
      else if (inner[j] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    const expression = inner.slice(i + 1, end);
    // 含 JSX → 图标；不含 JSX → 字符串表达式，算有文字。
    if (!expression.includes("<") && /[\p{L}\p{N}]/u.test(expression)) return true;

    i = end;
  }

  const literalText = outsideBraces.replace(/<[^>]*>/g, "");
  return /[\p{L}\p{N}]/u.test(literalText);
}

/**
 * 扫描一类元素的可访问名。
 *
 * `tagNames` 同时覆盖原生标签与「渲染成 <a> 的组件」：本项目里
 * `CosmicLink` 与 `next/link` 的 `Link` 都会产出 `<a>`，只扫小写 `<a` 会漏掉
 * 绝大多数链接（`Navigation.tsx:84` 的导航项就是 CosmicLink）。
 *
 * 返回两件事：违规列表 + 「因 spread 无法判定」的列表（后者只登记，不判失败）。
 */
function scanAccessibleNames(tagNames: readonly string[]): { violations: string[]; undecidable: string[] } {
  const violations: string[] = [];
  const undecidable: string[] = [];
  const group = tagNames.join("|");
  const openRe = new RegExp(`<(${group})\\b`, "g");

  for (const abs of TSX_FILES) {
    const source = stripComments(read(abs));
    let match: RegExpExecArray | null;
    while ((match = openRe.exec(source)) !== null) {
      const openEnd = findOpenTagEnd(source, match.index);
      if (openEnd === -1) continue;
      const tag = match[1];
      const openTag = source.slice(match.index, openEnd + 1);
      const line = source.slice(0, match.index).split("\n").length;

      if (hasExplicitName(openTag)) continue;

      if (/\{\.\.\./.test(openTag) && SPREAD_PASSTHROUGH.has(rel(abs))) {
        undecidable.push(`${rel(abs)}:${line} <${tag}>`);
        continue;
      }

      // 自闭合元素没有子内容，只能靠 ARIA 命名。
      const selfClosing = openTag.trimEnd().endsWith("/>");
      const closeTag = `</${tag}>`;
      const closeIndex = selfClosing ? -1 : source.indexOf(closeTag, openEnd + 1);

      if (selfClosing || closeIndex === -1) {
        violations.push(`${rel(abs)}:${line} :: ${openTag.replace(/\s+/g, " ").slice(0, 110)}`);
        continue;
      }

      if (hasInnerText(source.slice(openEnd + 1, closeIndex))) continue;

      violations.push(
        `${rel(abs)}:${line} :: ${source.slice(match.index, closeIndex + closeTag.length).replace(/\s+/g, " ").slice(0, 110)}`,
      );
    }
  }

  return { violations, undecidable };
}

test("W3：全部 <a> / Link / CosmicLink 都有可访问名（文字或 aria-label）", () => {
  const { violations, undecidable } = scanAccessibleNames(["a", "Link", "CosmicLink"]);
  assert.deepEqual(violations, [], `链接缺少可访问名（只有图标时请加 aria-label）：\n${violations.join("\n")}`);

  // spread 包装组件只登记、不判失败；数量被钉死，一旦变多说明有人新写了
  // 一个「把 props 全转发」的包装且没在这里登记，需要人工复核。
  assert.equal(
    undecidable.length,
    SPREAD_PASSTHROUGH.size,
    `源码里有 ${undecidable.length} 处因 props spread 无法静态判定可访问名（登记了 ${SPREAD_PASSTHROUGH.size} 个文件），请复核并更新 SPREAD_PASSTHROUGH：\n${undecidable.join("\n")}`,
  );
  for (const [key, reason] of SPREAD_PASSTHROUGH) {
    assert.ok(reason.trim().length >= 20, `W3 SPREAD_PASSTHROUGH 条目理由太短：${key}`);
  }
});

test("W3b：全部 <button> 都有可访问名（文字或 aria-label）", () => {
  const { violations } = scanAccessibleNames(["button"]);
  assert.deepEqual(violations, [], `按钮缺少可访问名（只有图标时请加 aria-label）：\n${violations.join("\n")}`);
});

test("W3c：图标按钮确实都加了 aria-label（列出实证，防止 W3 空转）", () => {
  // W3 是「没有名字就红」。如果未来所有按钮都变成有文本，W3 会一直绿但不再
  // 证明任何事。这条测试要求「至少存在若干个确实只有图标、靠 aria-label 拿到
  // 名字的按钮」—— 它们是本项目无障碍实现的主战场。
  const icons = [
    path.join(SRC_ROOT, "components", "layout", "Navigation.tsx"),
    path.join(APP_ROOT, "admin", "admin-chrome.tsx"),
  ];

  let iconButtonsWithLabel = 0;
  for (const abs of icons) {
    const source = stripComments(read(abs));
    for (const match of source.matchAll(/<button\b/g)) {
      const openEnd = findOpenTagEnd(source, match.index);
      if (openEnd === -1) continue;
      const openTag = source.slice(match.index, openEnd + 1);
      if (!hasExplicitName(openTag)) continue;

      const closeIndex = source.indexOf("</button>", openEnd + 1);
      if (closeIndex === -1) continue;
      if (hasInnerText(source.slice(openEnd + 1, closeIndex))) continue;
      iconButtonsWithLabel += 1;
    }
  }

  assert.ok(
    iconButtonsWithLabel >= 2,
    `预期 Navigation 与 admin-chrome 的抽屉按钮都靠 aria-label 命名，实际只找到 ${iconButtonsWithLabel} 个`,
  );
});

test("W3d：可折叠菜单按钮同时暴露 aria-expanded 与 aria-controls", () => {
  // 4.1.2 要求「状态」也可被辅助技术读到。只有 aria-label 不够：
  // 读屏用户需要知道「现在展开还是收起」。
  const navigation = read(path.join(SRC_ROOT, "components", "layout", "Navigation.tsx"));

  assert.match(navigation, /aria-expanded=\{open\}/, "Navigation 的菜单按钮缺 aria-expanded");
  assert.match(navigation, /aria-controls="mobile-nav"/, "Navigation 的菜单按钮缺 aria-controls");
  assert.match(
    navigation,
    /<nav\s+id="mobile-nav"/,
    'Navigation 里 aria-controls 指向的 id="mobile-nav" 必须真实存在于 <nav> 上',
  );

  const chrome = read(path.join(APP_ROOT, "admin", "admin-chrome.tsx"));
  assert.match(chrome, /aria-expanded=\{drawerOpen\}/, "admin-chrome 的抽屉按钮缺 aria-expanded");
});

/* -------------------------------------------------------------------------- */
/* W4 · 禁止硬编码颜色                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 「硬编码」的判据分两类。
 *
 * ── 类 1：实色工具类 ────────────────────────────────────────────────────────
 * `bg-white` / `text-black` / `bg-gray-100` / `text-slate-500` 这类**实色**。
 * 它们在 `.dark` 下不会翻转 —— 深色页面上突然一块纯白，正是暗色模式最常见的
 * 破相方式。全部禁止，没有例外。
 *
 * **刻意排除带透明度后缀的写法**（`bg-white/[0.04]`、`bg-white/5`）：那是
 * 「在恒定深空的宇宙层上盖一层极淡白光」的惯用手法，语义上并不依赖主题翻转。
 * 用 `(?![/\w-])` 把它排除掉，避免为了 5 处宇宙层装饰开一堆豁免。
 *
 * ── 类 2：十六进制字面量 ────────────────────────────────────────────────────
 * CSS 里的 `#rrggbb` 无法跟随令牌翻转。但有两类**必须**写字面量：
 *   · `metadata.themeColor` / `<meta name="theme-color">` —— Next.js 要求静态值，
 *     不接受 CSS 变量。
 *   · 宇宙层恒定额色（`lib/cosmic.ts`）—— 设计上明确「不受 Light/Dark 影响」。
 * 这两类走 `ALLOWED_LITERAL_FILES` 白名单，每条附理由。
 */
const BLOCKED_SOLID_COLOR_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: "实色白底", re: /\bbg-white(?![/\w-])/ },
  { label: "实色黑字", re: /\btext-black(?![/\w-])/ },
  { label: "灰色系实色", re: /\b(?:bg|text|border|from|to)-(?:gray|slate|zinc|neutral|stone)-\d{2,3}\b/ },
  { label: "调色板实色（xxx-500 等）", re: /\b(?:bg|text|border)-(?:red|blue|green|yellow|purple|pink|indigo|teal|cyan|orange|amber|lime|emerald|sky|violet|fuchsia|rose)-\d{2,3}\b/ },
];

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/;

/** 允许出现十六进制字面量的文件。值为理由，空字符串视为违规（有断言兜住）。 */
const ALLOWED_LITERAL_FILES: ReadonlyMap<string, string> = new Map([
  [
    "apps/web/src/lib/cosmic.ts",
    "宇宙层恒定额色表（--cosmic-* 的 TS 镜像，供 canvas / 内联 style 使用）。设计上明确不随主题变化。",
  ],
  [
    "apps/web/src/app/layout.tsx",
    "THEME_COLORS：主题色元数据必须给字面量，Next.js 的 themeColor 不接受 CSS 变量。",
  ],
  [
    "apps/web/src/components/layout/ThemeToggle.tsx",
    "运行时改 <meta name=\"theme-color\"> 的 content，同样只接受字面量。",
  ],
  [
    "apps/web/src/app/(cosmic)/layout.tsx",
    "宇宙层分区布局的 metadata.themeColor（恒定深空底色）。",
  ],
  [
    "apps/web/src/app/(cosmic)/page.tsx",
    "cosmicSections 的 accent 兜底值 #e8ecf6：属于宇宙层恒定额色，与 lib/cosmic.ts 同源。",
  ],
]);

test("W4：没有实色硬编码工具类（bg-white / text-black / bg-gray-* 等）", () => {
  const violations: string[] = [];

  for (const abs of SOURCE_FILES) {
    const lines = strippedLines(abs);
    lines.forEach((line, index) => {
      for (const pattern of BLOCKED_SOLID_COLOR_PATTERNS) {
        if (pattern.re.test(line)) {
          violations.push(`${rel(abs)}:${index + 1} :: [${pattern.label}] ${line.trim().slice(0, 100)}`);
          break;
        }
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `发现不随主题翻转的实色工具类（请改用 bg-surface / text-foreground 等语义令牌）：\n${violations.join("\n")}`,
  );
});

test("W4b：十六进制字面量只出现在已登记的文件里", () => {
  const violations: string[] = [];

  for (const abs of SOURCE_FILES) {
    const key = rel(abs);
    if (ALLOWED_LITERAL_FILES.has(key)) continue;
    const lines = strippedLines(abs);
    lines.forEach((line, index) => {
      if (HEX_COLOR_RE.test(line)) {
        violations.push(`${key}:${index + 1} :: ${line.trim().slice(0, 100)}`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `十六进制颜色出现在未登记的文件里（要么改用令牌，要么在 ALLOWED_LITERAL_FILES 里写清理由）：\n${violations.join("\n")}`,
  );

  for (const [key, reason] of ALLOWED_LITERAL_FILES) {
    assert.ok(reason.trim().length >= 10, `W4 allowlist 条目理由太短，等于没写：${key}`);
  }
});

test("W4c：透明度过低的宇宙层叠色只出现在 cosmic 作用域相关文件里", () => {
  // `bg-white/[0.04]` 这类写法被 W4 放行了，但放行前提是「它盖在恒定深空上」。
  // 一旦有人把它用到普通内容卡片上，在浅色主题下就是一层看不见的白色 —— 等于
  // 静默失效。这条测试把白名单收紧成「只允许出现在宇宙层相关的文件」。
  const allowedCosmicFiles = new Set<string>([
    "apps/web/src/app/error.tsx",
    "apps/web/src/app/not-found.tsx",
    "apps/web/src/components/cosmic/StarMap.tsx",
    "apps/web/src/components/project/ProjectCard.tsx",
    "apps/web/src/app/(cosmic)/page.tsx",
  ]);

  const violations: string[] = [];
  for (const abs of TSX_FILES) {
    const key = rel(abs);
    const lines = strippedLines(abs);
    lines.forEach((line, index) => {
      if (/\b(?:bg|border)-white\/\[?[\d.]+\]?/.test(line) && !allowedCosmicFiles.has(key)) {
        violations.push(`${key}:${index + 1} :: ${line.trim().slice(0, 100)}`);
      }
    });
  }

  assert.deepEqual(violations, [], `白色透明叠色跑到了非宇宙层文件：\n${violations.join("\n")}`);
});

/* -------------------------------------------------------------------------- */
/* W5 · `@theme inline` 必须覆盖 :root 的颜色短名                                */
/* -------------------------------------------------------------------------- */

/** 解析一个 CSS 块内的 `--name: value;` 声明，返回 name → value。 */
function parseCssVars(css: string, blockStart: number): Map<string, string> {
  // 从块起始的 `{` 开始做花括号配对，取出块内文本。
  let depth = 0;
  let end = blockStart;
  for (let i = blockStart; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = css.slice(blockStart + 1, end);

  const vars = new Map<string, string>();
  const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    vars.set(match[1], match[2].trim());
  }
  return vars;
}

/** 找到 `selector` 对应的块起始花括号下标。 */
function findBlockStart(css: string, selectorPattern: RegExp): number {
  const match = selectorPattern.exec(css);
  assert.ok(match !== null, `globals.css 里找不到 ${selectorPattern}`);
  const braceIndex = css.indexOf("{", match.index);
  assert.ok(braceIndex !== -1, `globals.css 里 ${selectorPattern} 后面没有花括号`);
  return braceIndex;
}

interface ThemeAudit {
  rootVars: Map<string, string>;
  darkVars: Map<string, string>;
  inlineVars: Map<string, string>;
  plainThemeVars: Map<string, string>;
}

function parseGlobalsCss(): ThemeAudit {
  const css = read(GLOBALS_CSS);
  return {
    rootVars: parseCssVars(css, findBlockStart(css, /(^|\n):root\s*\{/)),
    darkVars: parseCssVars(css, findBlockStart(css, /(^|\n)\.dark\s*\{/)),
    inlineVars: parseCssVars(css, findBlockStart(css, /(^|\n)@theme\s+inline\s*\{/)),
    plainThemeVars: parseCssVars(css, findBlockStart(css, /(^|\n)@theme\s*\{/)),
  };
}

/**
 * 「颜色类」短名 = 需要生成颜色工具类的令牌。
 *
 * 排除项与理由：
 *   · `--color-*`：那是 `:root` 里已经写好的**规范名**（任务书 4.1 清单），
 *     它们本身就是映射结果，不需要再被映射一次。
 *   · `--dur-*`：时长，不是颜色，对应 Tailwind 的 `duration-*` 命名空间
 *     （本项目没用工具类，靠内联 style 消费）。
 *   · `--font-*` / `--ease-*`：字体与缓动，各有自己的 `@theme` 命名空间，
 *     且 `--ease-*` 明确写在非 inline 的 `@theme`（globals.css:101-104 有解释：
 *     inline 只内联值、不产出可被 var() 引用的变量）。
 */
function isColorShortName(name: string): boolean {
  if (name.startsWith("--color-")) return false;
  if (name.startsWith("--dur-")) return false;
  if (name.startsWith("--font-")) return false;
  if (name.startsWith("--ease-")) return false;
  return true;
}

/**
 * 已知「有短名但没映射成工具类」的令牌。
 *
 * 这是**缺陷清单**，不是豁免。当前两条的特征相同：短名在 `:root` 里声明了，
 * 但 `@theme inline` 里没有对应的 `--color-*`，所以用它的工具类
 * （`text-accent-alt`）不报错、也不产出任何 CSS —— 与 P5 修掉的
 * `muted-deep` / `border-focus` 是同一个坑，只是目前**恰好没人用**。
 *
 * 本测试对它们的处理是双向的：
 *   · 反向断言：条目必须仍然「真的有短名、真的没映射」。
 *   · 正向断言：对应的工具类在源码里**必须零使用**。一旦有人写了
 *     `text-accent-alt`，测试立刻红，逼迫先补映射。
 */
const UNMAPPED_TOKEN_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    "--accent-alt",
    "次强调色（青）。短名在 :root:32 与 .dark:91 声明，但 @theme inline 里没有 " +
      "--color-accent-alt，故 bg-accent-alt / text-accent-alt 这类类名会静默失效。" +
      "当前源码 0 处使用（已由本测试的零使用断言守护），属潜伏缺陷而非当前破相。" +
      "要修：在 globals.css 的 @theme inline 块里加一行 `--color-accent-alt: var(--accent-alt);`。",
  ],
]);

test("W5：`:root` 里每个颜色短名都在 `@theme inline` 里有 `--color-*` 映射", () => {
  const { rootVars, inlineVars } = parseGlobalsCss();

  const colorShortNames = [...rootVars.keys()].filter(isColorShortName).sort();
  assert.ok(colorShortNames.length >= 20, `只解析到 ${colorShortNames.length} 个颜色短名，解析大概率坏了`);

  const missing: string[] = [];
  for (const name of colorShortNames) {
    const mapped = inlineVars.has(`--color-${name.slice(2)}`);
    if (!mapped && !UNMAPPED_TOKEN_ALLOWLIST.has(name)) missing.push(name);
  }

  assert.deepEqual(
    missing,
    [],
    `这些短名没有 --color-* 映射，用它们的工具类会静默失效（P5 同类缺陷）：\n${missing.join("\n")}`,
  );
});

test("W5b：UNMAPPED_TOKEN_ALLOWLIST 双向有效（确实未映射 + 工具类确实零使用）", () => {
  const { rootVars, inlineVars } = parseGlobalsCss();

  for (const [name, reason] of UNMAPPED_TOKEN_ALLOWLIST) {
    assert.ok(reason.trim().length >= 20, `W5 allowlist 条目理由太短：${name}`);

    assert.ok(rootVars.has(name), `${name} 在 allowlist 里，但 :root 已经没有这个短名了 —— 请删掉条目`);
    assert.ok(
      !inlineVars.has(`--color-${name.slice(2)}`),
      `${name} 已经被映射成工具类了 —— 请从 allowlist 删掉它（这条豁免已经无效）`,
    );

    // 零使用断言：`text-accent-alt` / `bg-accent-alt` / `border-accent-alt` / `fill-accent-alt` 等。
    const utility = name.slice(2); // accent-alt
    const usageRe = new RegExp(
      `\\b(?:bg|text|border|fill|stroke|ring|from|to|via|placeholder|divide|outline|accent|decoration|shadow)-(?:${utility})\\b`,
    );
    const hits: string[] = [];
    for (const abs of SOURCE_FILES) {
      strippedLines(abs).forEach((line, index) => {
        if (usageRe.test(line)) hits.push(`${rel(abs)}:${index + 1} :: ${line.trim().slice(0, 90)}`);
      });
    }
    assert.deepEqual(
      hits,
      [],
      `${name} 没有工具类映射，但源码里已经在用它的类名（这些类名不产出 CSS）：\n${hits.join("\n")}`,
    );
  }
});

test("W5c：`@theme inline` 的每个 `--color-*` 都必须写成 `var(--短名)`，不能内联字面量", () => {
  // globals.css:117-118 的注释点明了原因：内联字面量会绕过 .dark 的覆盖，
  // 于是「暗色模式失效」而且**看不出来**。这条测试把那个约定变成断言。
  const { inlineVars } = parseGlobalsCss();

  const colorEntries = [...inlineVars.entries()].filter(([name]) => name.startsWith("--color-"));
  assert.ok(colorEntries.length >= 20, `@theme inline 里只有 ${colorEntries.length} 个 --color-*，解析大概率坏了`);

  const offenders: string[] = [];
  for (const [name, value] of colorEntries) {
    const expected = `var(--${name.slice("--color-".length)})`;
    if (value !== expected) {
      offenders.push(`${name}: ${value}（应为 ${expected}）`);
    }
  }

  assert.deepEqual(offenders, [], `@theme inline 里的颜色必须 var() 引用短名：\n${offenders.join("\n")}`);
});

test("W5d：`.dark` 覆盖了每一个「会随主题变化」的颜色短名", () => {
  // 判据：`:root` 里除 `--cosmic-*`（设计上恒定）以外的颜色短名，都必须在
  // `.dark` 块里被重新赋值。否则暗色模式下该令牌保持浅色值，对比度必然出问题。
  //
  // 已知的两个合法例外：
  //   · `--on-accent` 在 .dark:90 有覆盖，但值也变了（#ffffff → #060a18），符合预期。
  //   · `--cosmic-*` 明确「不受 Light/Dark 主题影响」（globals.css:54 注释）。
  const { rootVars, darkVars } = parseGlobalsCss();

  const mustOverride = [...rootVars.keys()]
    .filter(isColorShortName)
    .filter((name) => !name.startsWith("--cosmic-"))
    .sort();

  const missing = mustOverride.filter((name) => !darkVars.has(name));
  assert.deepEqual(missing, [], `这些颜色短名没有 .dark 覆盖：\n${missing.join("\n")}`);
});

test("W5e：P5 修过的两个缺陷（muted-deep / border-focus）保持修复状态", () => {
  // 这是最直接的一条回归守卫。globals.css:120-142 的长注释记录了当时的后果：
  // `text-muted-deep` 在构建产物里命中 0 次（27 处用法全部静默失效）、
  // `/search` 的搜索框聚焦边框不变色。这两行不能被删。
  const { inlineVars } = parseGlobalsCss();

  assert.equal(inlineVars.get("--color-muted-deep"), "var(--muted-deep)", "--color-muted-deep 映射丢失（27 处用法会静默失效）");
  assert.equal(
    inlineVars.get("--color-border-focus"),
    "var(--border-focus)",
    "--color-border-focus 映射丢失（聚焦边框会不变色）",
  );

  // 用法数量也要还在。如果用法被删光，上面的映射就变成了死代码，
  // 那时的正确动作是提醒设计者而不是继续守着。
  const countUsage = (pattern: RegExp): number => {
    let count = 0;
    for (const abs of SOURCE_FILES) {
      for (const line of strippedLines(abs)) {
        if (pattern.test(line)) count += 1;
      }
    }
    return count;
  };
  assert.ok(countUsage(/\btext-muted-deep\b/) > 0, "text-muted-deep 已无任何使用，请复核 P5 修复是否还有意义");
  assert.ok(countUsage(/\bborder-border-focus\b/) > 0, "border-border-focus 已无任何使用，请复核 P5 修复是否还有意义");
});

/* -------------------------------------------------------------------------- */
/* W6 · 触控命中区域 ≥ 44px                                                     */
/* -------------------------------------------------------------------------- */

/** 等效于 44px 的类名token。`py-3` = 12px×2 + 20px（text-sm 行高）= 44px。 */
const TOUCH_TARGET_TOKENS: readonly RegExp[] = [
  /\bmin-h-11\b/,
  /\bh-11\b/,
  /\bsize-11\b/,
  /\bmin-h-\[44px\]/,
  /\bh-\[44px\]/,
  /\bpy-3\b/,
  /\bp-3\b/,
  /\bpy-3\.5\b/,
];

function hasTouchTarget(classNameText: string): boolean {
  return TOUCH_TARGET_TOKENS.some((re) => re.test(classNameText));
}

/**
 * 已知不满足 44px 的交互元素。**这是缺陷清单，不是豁免**。
 *
 * **现在为空** —— task-18（P6-D）把原来登记的 4 条全部修掉了（都在
 * `admin-chrome.tsx`：抽屉按钮 32→44、导航项 36→44、返回站点 16→44、登出 28→44）。
 * 空表本身不是目的：W6 仍然对全部扫出来的交互元素设 44px 阈值，
 * 而 W6c 把修好的 4 处逐项钉住，防止哪天又被改回去。
 *
 * 反向断言：条目必须仍然是违规；修好之后测试会红，逼迫回来删条目。
 */
const KNOWN_TOUCH_TARGET_GAPS: ReadonlyMap<string, string> = new Map([]);

interface TouchCandidate {
  key: string;
  element: string;
  classNameText: string;
}

/**
 * 从 `source` 里取出 `fnName` 这个函数的**完整声明文本**（用于收集它内部的
 * 字符串字面量），找不到返回 `null`。
 *
 * ══ 为什么不用正则收尾 ══
 * 第一版是 `const\s+fn\s*=[\s\S]*?(?:\n\};?|\n\];?|\n\);?|\n;|\n\n)`，
 * 两个缺陷叠加，让 W6 对 `Navigation.tsx` 完全空转：
 *
 * 1. **CRLF**：收尾分支全写 `\n`，而 `Navigation.tsx` 是 CRLF
 *    （实测 CRLF=140 / bareLF=0），`\n\n` 匹配不到 `\r\n\r\n`，
 *    于是从 `const desktopLinkClass =` 一路吃到文件末尾，
 *    把移动端的 `min-h-11` 也算进桌面端。
 * 2. **剥注释后空行不可辨**：本文件 `stripComments()` 把注释替换成纯空格，
 *    `desktopLinkClass` 数组首行前的 `// min-h-11：…WCAG 2.5.5` 剥完就是
 *    「换行 + 空格 + 换行」，与空行同形 —— 即便把行尾改成 `\r?\n`，
 *    `\n\s*\n` 仍会在数组第一项之前就收尾。
 *
 * 所以改成**括号配对**：定位到 `=` 之后，从第一个 `(` / `[` / `{` 起算深度，
 * 深度回到 0 即为声明结束。与行尾风格、注释、缩进全部无关，
 * 也顺手支持 `const fn = (…) => { … }` 与 `const fn = (…) => [ … ]` 两种写法。
 */
function extractDeclBody(source: string, fnName: string): string | null {
  const declRe = new RegExp(`(?:const|let|var)\\s+${fnName}\\s*(?::[^=]+)?=|function\\s+${fnName}\\s*\\(`);
  const decl = declRe.exec(source);
  if (decl === null) return null;

  const isArrowForm = !decl[0].startsWith("function");
  let from = decl.index + decl[0].length;

  if (isArrowForm) {
    // `const fn = (a: string) => [ ... ]`：参数列表的括号也在 `=` 之后，
    // 必须跳过它，否则会在参数括号闭合处就误判成「声明结束」。
    const arrow = source.indexOf("=>", from);
    if (arrow === -1) return null;
    from = arrow + 2;
  }

  let depth = 0;
  let started = false;

  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      started = true;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (started && depth === 0) return source.slice(decl.index, i + 1);
      continue;
    }
    // 还没遇到任何括号就先碰到分号：形如 `const fn = otherFn;`，直接收到分号。
    if (!started && ch === ";") return source.slice(decl.index, i + 1);
  }

  return null;
}

/**
 * 从文件里收集「交互元素 → 它最终的 className 文本」。
 *
 * 难点：`Navigation.tsx` 的 className 不是字面量，而是
 * `desktopLinkClass(href)` / `mobileLinkClass(href)` 两个函数的返回值。
 * 所以这里做一层**同文件函数内联**：className 若是裸标识符或调用表达式，
 * 就去文件里找同名函数，把它函数体里的全部字符串字面量拼起来当作 className。
 * 这样 `min-h-11` 写在函数体数组里也能被看见。
 */
function collectTouchCandidates(abs: string): TouchCandidate[] {
  const source = stripComments(read(abs));
  const out: TouchCandidate[] = [];

  const elementRe = /<(button|a|Link|CosmicLink)\b/g;
  let match: RegExpExecArray | null;
  while ((match = elementRe.exec(source)) !== null) {
    const tag = match[1];
    const openEnd = findOpenTagEnd(source, match.index);
    if (openEnd === -1) continue;

    const attrs = source.slice(match.index + tag.length + 1, openEnd);
    const line = source.slice(0, match.index).split("\n").length;

    let classNameText = "";
    const literal = attrs.match(/className=(?:"([^"]*)"|\{"([^"]*)"\})/);
    if (literal !== null) {
      classNameText = literal[1] ?? literal[2] ?? "";
    } else {
      const expression = attrs.match(/className=\{([\s\S]*?)\}\s*(?=[\w-]+=|$)/);
      if (expression !== null) {
        const expr = expression[1].trim();
        const callee = expr.match(/^([A-Za-z_$][\w$]*)\s*\(/);
        const fnName = callee !== null ? callee[1] : /^[A-Za-z_$][\w$]*$/.test(expr) ? expr : null;
        if (fnName !== null) {
          // 函数可能是 `const fn = (...) => [...]` 也可能是 `function fn(...)`。
          // 取「整个声明」的文本，里面所有字符串字面量都会被 hasTouchTarget() 逐条匹配。
          //
          // ══ 为什么不能用正则按行尾收尾（P6-I / P1-3 修的就是这里）══
          // 第一版写的是 `const\s+fn\s*=[\s\S]*?(?:\n\};?|\n\];?|\n\);?|\n;|\n\n)`。
          // 两个独立缺陷叠在一起：
          //   1. 收尾分支全用 `\n`，而被扫描的 `Navigation.tsx` 是 **CRLF**
          //      （实测 CRLF=140 / bareLF=0 / 5122 B），`\n\n` 永远匹配不到
          //      `\r\n\r\n` —— 于是 `arrowRe` 从 `const desktopLinkClass =`
          //      一路吃到底，把整个组件（**含移动端 `mobileLinkClass` 里的
          //      `min-h-11`**）都当成桌面端的函数体。删掉桌面端第 53 行的
          //      `min-h-11` 后 W6 仍然全绿，根因就在这里。
          //   2. 就算把行尾改成 `\r?\n`，`\n\s*\n`（空行收尾）仍然会误判：
          //      本文件 `stripComments()` 把注释行替换成**纯空格**，
          //      `desktopLinkClass` 数组第一行之前正好有一行注释
          //      （`// min-h-11：…WCAG 2.5.5`），剥完就是「换行 + 空格 + 换行」，
          //      与空行无法区分 —— 实测退化成只取到 `=> [ ` 就收尾。
          //
          // 所以改成**括号配对**：从 `=>` 之后开始，数 `(` `[` `{` 的配对，
          // 深度回到 0 就收尾。与行尾、注释、缩进全部无关。
          classNameText = extractDeclBody(source, fnName) ?? "";
        } else if (/className=\{\[/.test(attrs)) {
          // 直接内联的数组写法：`className={[ "...", active ? "..." : "..." ].join(" ")}`
          classNameText = expr;
        }
      }
    }

    out.push({ key: `${rel(abs)}:${line}`, element: tag, classNameText });
  }

  return out;
}

test("W6：Navigation 与 admin-chrome 的交互元素达到 44px 命中区域", () => {
  const targets = [
    path.join(SRC_ROOT, "components", "layout", "Navigation.tsx"),
    path.join(APP_ROOT, "admin", "admin-chrome.tsx"),
  ];

  const violations: string[] = [];
  const allowlisted: string[] = [];

  for (const abs of targets) {
    for (const candidate of collectTouchCandidates(abs)) {
      if (hasTouchTarget(candidate.classNameText)) continue;
      const reason = KNOWN_TOUCH_TARGET_GAPS.get(candidate.key);
      if (reason !== undefined) {
        allowlisted.push(candidate.key);
        continue;
      }
      const snippet = candidate.classNameText.replace(/\s+/g, " ").slice(0, 90);
      violations.push(`${candidate.key} <${candidate.element}> :: ${snippet || "(无可读 className)"}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `交互元素缺 44px 命中区域（加 min-h-11 / h-11 / py-3 之一）：\n${violations.join("\n")}`,
  );

  for (const [key, reason] of KNOWN_TOUCH_TARGET_GAPS) {
    assert.ok(reason.trim().length > 0, `W6 allowlist 条目缺理由：${key}`);
    assert.ok(allowlisted.includes(key), `W6 allowlist 里的 ${key} 已经合规了 —— 请删掉条目`);
  }
});

test("W6b：Navigation 的三类交互元素各自带 44px 声明（逐项钉住，不靠整体正则）", () => {
  // W6 是对「扫出来的元素」设阈值，如果 collectTouchCandidates 的解析退化
  // （比如 className 变成模板字符串），W6 会扫到 0 个元素然后「通过」。
  // 这条测试对三个已知位置逐项断言，等于给 W6 装了空转探测器。
  const source = read(path.join(SRC_ROOT, "components", "layout", "Navigation.tsx"));
  const stripped = stripComments(source);

  // ══ 原来这里用的是 `assert.match(source, /desktopLinkClass[\s\S]{0,600}?min-h-11/)` ══
  // 600 字符窗口是个假闸门：`mobileLinkClass` 里的 `min-h-11` 只隔 **171 字符**，
  // 所以删掉桌面端那条 `min-h-11` 后，正则仍能从 `desktopLinkClass` 出发
  // 在窗口内吃到移动端的那条 —— 实测（P6 闸门矩阵 W6b）确实全绿。
  // 现在改成**取函数声明本体再断言**，与 collectTouchCandidates 用同一套括号配对，
  // 窗口宽度不再是判据，函数边界才是。
  const desktopBody = extractDeclBody(stripped, "desktopLinkClass");
  const mobileBody = extractDeclBody(stripped, "mobileLinkClass");

  assert.ok(desktopBody !== null, "Navigation.tsx 里找不到 desktopLinkClass 的声明（函数被改名或删了）");
  assert.ok(mobileBody !== null, "Navigation.tsx 里找不到 mobileLinkClass 的声明（函数被改名或删了）");

  assert.match(desktopBody, /\bmin-h-11\b/, "桌面导航链接缺 min-h-11（在 desktopLinkClass 本体里没找到）");
  assert.match(mobileBody, /\bmin-h-11\b/, "移动端导航链接缺 min-h-11（在 mobileLinkClass 本体里没找到）");

  // 反向守卫：桌面端那条必须**不在**移动端的本体里，否则「两个函数共用一段文本」
  // 会让上一条断言重新变成空转。两个函数体不许有交叠。
  assert.ok(
    !mobileBody.includes(desktopBody),
    "mobileLinkClass 的本体包含了 desktopLinkClass 的本体 —— 括号配对把两个函数并成一段了",
  );

  assert.match(source, /className="inline-flex h-11 w-11/, "移动端菜单按钮应同时是 h-11 w-11");
  assert.match(source, /WCAG 2\.5\.5/, "Navigation.tsx 里解释 44px 理由的注释被删了（说明有人不理解为什么有 min-h-11）");
});

test("W6c：task-18 修掉的 4 处后台命中区域保持 44px（逐项钉住）", () => {
  // KNOWN_TOUCH_TARGET_GAPS 清空之后，W6 只剩「对扫出来的元素设阈值」这一层。
  // 万一 collectTouchCandidates 对 admin-chrome.tsx 的数组式 className 解析退化，
  // W6 会扫到 0 个元素然后「通过」—— 四个缺陷会静默复活。
  // 所以这里逐项钉住修复后的原文，等于给 W6 装了针对这四处的空转探测器。
  const source = read(path.join(APP_ROOT, "admin", "admin-chrome.tsx"));

  // 1. 移动端抽屉菜单按钮：32×32 → 44×44
  assert.match(
    source,
    /<button\b[\s\S]{0,400}?aria-label=\{drawerOpen \? "关闭菜单" : "打开菜单"\}[\s\S]{0,300}?inline-flex h-11 w-11 items-center justify-center/,
    "移动端抽屉菜单按钮不再是 h-11 w-11（44×44）—— 它会退回 32×32",
  );

  // 2. 侧边栏导航项：36 → 44，且必须保留 py-2（多行文本要能撑开）
  assert.match(
    source,
    /"flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"/,
    "侧边栏导航项缺 min-h-11 或丢了 py-2（min-h 是下限，py 负责多行撑开）",
  );

  // 3. 「返回站点」链接：16 → 44
  assert.match(
    source,
    /<Link[\s\S]{0,300}?className="inline-flex min-h-11 items-center text-xs text-muted hover:text-accent"/,
    "「返回站点」链接不再是 inline-flex min-h-11 items-center —— 它会退回 16px",
  );

  // 4. 「登出」按钮：28 → 44
  assert.match(
    source,
    /<button[\s\S]{0,300}?className="inline-flex min-h-11 items-center rounded-lg border border-border px-2\.5 text-xs/,
    "「登出」按钮缺 min-h-11 —— 它会退回 28px，且与相邻的「返回站点」互相误触",
  );

  assert.match(
    source,
    /WCAG 2\.5\.5/,
    "admin-chrome.tsx 里解释 44px 理由的注释被删了（说明有人不理解为什么有 min-h-11）",
  );
});

/* -------------------------------------------------------------------------- */
/* W7 · <html lang> + 跳转链接锚点                                               */
/* -------------------------------------------------------------------------- */

test("W7：根布局的 <html> 声明了 lang，且带 suppressHydrationWarning", () => {
  const rootLayout = path.join(APP_ROOT, "layout.tsx");
  const source = read(rootLayout);

  const langMatch = source.match(/<html\b[\s\S]{0,400}?\blang="([^"]+)"/);
  assert.ok(langMatch !== null, "根布局的 <html> 没有 lang 属性（WCAG 3.1.1）");
  assert.equal(langMatch[1], "zh-CN", `<html lang> 应为 zh-CN，实际是 ${langMatch[1]}`);

  // suppressHydrationWarning 是 themeInitScript 在客户端改 <html class> 的必要条件，
  // 同时它也属于「暗色模式无 FOUC」方案的一部分（task-16 的 P6-D12 会更细地查）。
  assert.match(
    source,
    /<html\b[\s\S]{0,400}?suppressHydrationWarning/,
    "<html> 缺 suppressHydrationWarning —— 客户端切换 .dark 类会触发 hydration 警告",
  );
});

test("W7b：跳转链接的 #main 与真实存在的 id=\"main\" 对得上", () => {
  const rootLayout = read(path.join(APP_ROOT, "layout.tsx"));

  const hrefMatch = rootLayout.match(/href="#([\w-]+)"/);
  assert.ok(hrefMatch !== null, "根布局没有跳到正文的锚链接（WCAG 2.4.1 绕过区块）");
  const anchorId = hrefMatch[1];

  // 锚点必须落在某个 layout 的 <main> 上。四个分区布局各自提供自己的 <main id>：
  // (site)/layout.tsx、(cosmic)/layout.tsx、admin/admin-chrome.tsx、login/page.tsx。
  // 只要「至少一个真实存在」且根布局的 anchor 与之同名，跳转就是通的。
  const mainIdSites: string[] = [];
  for (const abs of walkDir(SRC_ROOT, ["node_modules", "__tests__"]).filter((f) => /\.tsx$/.test(f))) {
    const source = read(abs);
    if (new RegExp(`\\bid="${anchorId}"`).test(source) && /<main\b/.test(source)) {
      mainIdSites.push(rel(abs));
    }
  }

  assert.ok(
    mainIdSites.length >= 4,
    `id="${anchorId}" 应同时存在于 4 个分区的 <main> 上，实际只在 ${JSON.stringify(mainIdSites)}。` +
      "少一个就意味着一整个分区的跳转链接是死的。",
  );
});

test("W7c：跳转链接位于根布局，且排在所有导航之前", () => {
  // 2.4.1 的实质是「键盘用户第一次按 Tab 就能跳过导航」。所以跳转链接必须
  // 出现在**根布局**、且在 `{children}` 之前 —— 因为站点导航 <Navigation>
  // 并不在根布局里（见 layout.tsx:141-147 的注释：Navbar/Footer 下沉到
  // (site)/layout.tsx 的 Navbar，宇宙层外壳在 (cosmic)/layout.tsx）。
  //
  // 第一版这条测试写成「根布局里找 <Navigation>」，直接报「找不到」——
  // 事实是根布局刻意不渲染导航。判据必须换成「跳转链接在 children 之前」，
  // 这才是真正决定 Tab 顺序的东西。
  const rootLayout = read(path.join(APP_ROOT, "layout.tsx"));

  const skipIndex = rootLayout.search(/href="#main"/);
  assert.ok(skipIndex !== -1, "根布局里找不到跳转链接");

  const childrenIndex = rootLayout.search(/\{children\}/);
  assert.ok(childrenIndex !== -1, "根布局里找不到 {children}（这条测试的前提变了）");
  assert.ok(
    skipIndex < childrenIndex,
    "跳转链接必须出现在 {children} 之前 —— 否则它排在整棵子树（含全部导航）之后，键盘用户要 Tab 完整个导航才够得着",
  );

  // 反向确认：<Navigation> 确实不在根布局里。如果有一天它被上提回根布局，
  // 上面的 skipIndex < childrenIndex 仍然成立，但这条测试会提醒复核顺序。
  assert.ok(
    !/<Navigation\b/.test(rootLayout),
    "根布局出现了 <Navigation> —— 请复核跳转链接与导航的相对顺序（本条测试的前提已变）",
  );
});

/* -------------------------------------------------------------------------- */
/* W8 · 表单控件必须有 label                                                    */
/* -------------------------------------------------------------------------- */

/** 表单控件按需豁免的类型：hidden 不出现在视觉层，不需要 label。 */
const LABEL_EXEMPT_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset"]);

interface ControlSite {
  key: string;
  control: string;
  inputType: string;
  labelled: boolean;
}

/**
 * 判定一个控件的「可关联标签」，按 WCAG / HTML-AAM 的三种合法方式：
 *   A. 控件开标签上有 aria-label / aria-labelledby；
 *   B. 控件有 id，且文件里有 <label htmlFor="该 id"> 或 <label htmlFor={...}>；
 *   C. 控件**被包裹在 `<label>` 元素内部**（隐式关联）。
 *
 * 第三类是关键：`admin/content/page.tsx:162-176` 的「类型」下拉是
 * `<label className="block"><span>类型</span><select …>` —— 没有 id、没有
 * aria-label，但隐式关联是成立的。只查 A/B 会误报。反过来，`:205-229` 的
 * 「排序」那一组用的是 `<div>` + `<span>`，隐式关联**不成立**（span 不是 label），
 * 那是真缺陷。
 */
function collectControlSites(abs: string): ControlSite[] {
  const source = stripComments(read(abs));
  const sites: ControlSite[] = [];

  const re = /<(input|textarea|select)\b([\s\S]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const control = match[1];
    const attrs = match[2].replace(/\s+/g, " ");
    const line = source.slice(0, match.index).split("\n").length;
    const inputType = (attrs.match(/type="([^"]+)"/) ?? [, ""])[1];

    // A. 显式 ARIA
    const hasAria = /\baria-label=|\baria-labelledby=/.test(attrs);

    // B. id + htmlFor
    const idMatch = attrs.match(/\bid="([^"]+)"/);
    let hasHtmlFor = false;
    if (idMatch !== null) {
      const id = idMatch[1];
      hasHtmlFor = new RegExp(`htmlFor=(?:"${id}"|\\{"${id}"\\})`).test(source);
    }

    // C. 隐式关联：向上找最近的 <label ...> 开标签，且中间没遇到块级的
    //    闭合标签（</label>、</form>、</div> 都不该出现在 label 与控件之间）。
    const before = source.slice(0, match.index);
    const lastLabelOpen = before.lastIndexOf("<label");
    const lastLabelClose = before.lastIndexOf("</label>");
    const wrapped = lastLabelOpen !== -1 && lastLabelOpen > lastLabelClose;

    sites.push({
      key: `${rel(abs)}:${line}`,
      control,
      inputType,
      labelled: hasAria || hasHtmlFor || wrapped,
    });
  }

  return sites;
}

/**
 * 已知缺 label 的表单控件。**缺陷清单，不是豁免**，双向断言同 W6。
 *
 * **现在为空** —— task-18（P6-D）把原来登记的 3 条全部修掉了：
 *   · `content/page.tsx` 「排序」下拉 → 加 `aria-label="排序"`
 *   · `entry-editor.tsx` 里程碑标题输入框 → 加 `aria-label={里程碑 N 标题}`
 *   · `entry-editor.tsx` 里程碑勾选框 → 加 `aria-label={里程碑 N 已完成}`
 * W8c 逐项钉住这三处，防止回归。
 */
const KNOWN_FORM_LABEL_GAPS: ReadonlyMap<string, string> = new Map([]);

/**
 * 要扫的目录：`app/admin/**` 与 `app/login/**`。
 *
 * 为什么含 `components/admin/**`：`entry-editor.tsx` 是后台真正的表单主体，
 * 它不在 app/ 下但渲染的是后台表单控件。只扫 app/ 会漏掉后台 90% 的输入框。
 */
function formScanFiles(): string[] {
  const roots = [
    path.join(APP_ROOT, "admin"),
    path.join(APP_ROOT, "login"),
    path.join(SRC_ROOT, "components", "admin"),
  ];
  return roots
    .flatMap((root) => walkDir(root, ["node_modules", "__tests__"]))
    .filter((abs) => abs.endsWith(".tsx"))
    .sort();
}

test("W8：后台与登录页的表单控件都有可关联标签（ARIA / htmlFor / 隐式包裹）", () => {
  const violations: string[] = [];
  const allowlisted: string[] = [];
  let total = 0;
  let exempt = 0;

  for (const abs of formScanFiles()) {
    for (const site of collectControlSites(abs)) {
      total += 1;
      if (LABEL_EXEMPT_INPUT_TYPES.has(site.inputType)) {
        exempt += 1;
        continue;
      }
      if (site.labelled) continue;

      const reason = KNOWN_FORM_LABEL_GAPS.get(site.key);
      if (reason !== undefined) {
        allowlisted.push(site.key);
        continue;
      }
      violations.push(`${site.key} <${site.control} type=${site.inputType || "(默认)"}>`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `表单控件缺 label（请加 aria-label，或用 <label> 包裹，或 id + htmlFor）：\n${violations.join("\n")}`,
  );

  for (const [key, reason] of KNOWN_FORM_LABEL_GAPS) {
    assert.ok(reason.trim().length > 0, `W8 allowlist 条目缺理由：${key}`);
    assert.ok(allowlisted.includes(key), `W8 allowlist 里的 ${key} 已经修好了 —— 请删掉条目`);
  }

  // 空转探测器：如果扫描逻辑坏掉，total 会掉到 0 而测试照样绿。
  assert.ok(total >= 15, `只扫到 ${total} 个表单控件，预期至少 15 个（admin content 筛选栏 + entry-editor）`);
  assert.ok(exempt < total, "所有控件都被当成豁免类型了，W8 等于没扫");
});

test("W8b：entry-editor 的 Field 组件用 htmlFor 关联，且每个 Field 都有 label", () => {
  // entry-editor.tsx:166 起大量使用 `<Field label=... htmlFor=...>`，
  // 内部在 :537 渲染 `<label htmlFor={htmlFor}>`。这条测试钉住那个约定：
  // 一旦有人把 htmlFor 从 Field 的 props 里去掉，后台所有输入框会同时失去标签，
  // 而 W8 的隐式包裹判定救不了（Field 渲染的是 <label> 但控件是它的兄弟节点）。
  const editor = read(path.join(SRC_ROOT, "components", "admin", "entry-editor.tsx"));

  assert.match(editor, /<label htmlFor=\{htmlFor\}/, "Field 组件没把 htmlFor 传给 <label>，后台输入框会集体失去标签");

  const fieldUses = editor.match(/<Field\b[^>]*>/g) ?? [];
  assert.ok(fieldUses.length >= 10, `只找到 ${fieldUses.length} 处 <Field>，解析大概率坏了`);

  const missingHtmlFor = fieldUses.filter((tag) => !/\bhtmlFor=/.test(tag));
  assert.deepEqual(missingHtmlFor, [], `这些 <Field> 没传 htmlFor，生成的 label 关联不到控件：\n${missingHtmlFor.join("\n")}`);
});

test("W8c：task-18 修掉的 3 处表单标签保持存在（逐项钉住）", () => {
  // KNOWN_FORM_LABEL_GAPS 清空之后，W8 只剩「对扫出来的控件设阈值」这一层。
  // 若 collectControlSites 的 aria-label 正则哪天退化，这三处会静默复活。
  const contentPage = read(path.join(APP_ROOT, "admin", "content", "page.tsx"));
  assert.match(
    contentPage,
    /<select\b[\s\S]{0,200}?\bname="sort"[\s\S]{0,200}?aria-label="排序"/,
    "「排序」下拉的 aria-label 被删了 —— 它外层是 <div>+<span>，隐式关联不成立",
  );

  const editor = read(path.join(SRC_ROOT, "components", "admin", "entry-editor.tsx"));
  assert.match(
    editor,
    /aria-label=\{`里程碑 \$\{index \+ 1\} 标题`\}/,
    "goals 里程碑标题输入框的 aria-label 被删了或丢了序号（丢序号 = N 个同名字段）",
  );
  assert.match(
    editor,
    /aria-label=\{`里程碑 \$\{index \+ 1\} 已完成`\}/,
    "goals 里程碑勾选框的 aria-label 被删了或丢了序号（读屏只剩「复选框」）",
  );
});

/* -------------------------------------------------------------------------- */
/* 汇总                                                                        */
/* -------------------------------------------------------------------------- */

test("汇总：审计范围的自述（把数字钉在测试里，防止扫描悄悄变成空转）", () => {
  assert.ok(SOURCE_FILES.length >= 50, `只扫到 ${SOURCE_FILES.length} 个 ts/tsx 文件，预期至少 50 个`);
  assert.ok(TSX_FILES.length >= 40, `只扫到 ${TSX_FILES.length} 个 tsx 文件，预期至少 40 个`);
  assert.ok(pageFiles().length >= 20, `只扫到 ${pageFiles().length} 个 page.tsx，预期至少 20 个`);
  assert.ok(existsSync(GLOBALS_CSS), `globals.css 不存在：${GLOBALS_CSS}`);
  assert.equal(REPO_ROOT, path.resolve(REPO_ROOT), "REPO_ROOT 必须是绝对路径");

  // eslint-disable-next-line no-console -- 审计套件需要把范围打印出来，便于人工复核
  console.log(
    `[a11y-audit] repo=${REPO_ROOT} | ts/tsx=${SOURCE_FILES.length} | tsx=${TSX_FILES.length} | pages=${pageFiles().length}`,
  );
});
