/**
 * 后台守卫（`app/admin/layout.tsx`）的验收测试。
 *
 * ── 为什么需要这个文件（P6-I / P0-2）──────────────────────────────────
 * P6 的闸门矩阵报告做了这样一次变异：
 *
 *     删掉 apps/web/src/app/admin/layout.tsx:83 的 `redirect("/login")`
 *     → 234 条断言全绿
 *
 * 也就是说**后台守卫代码本身完全没人守**：`AdminGuard` / `getAdminSession` /
 * `admin/layout` 这些标识符在所有测试文件里零命中。把那一行删掉，站点仍然
 * 「所有测试通过」，而任何人都能直接打开 `/admin` 看全部草稿。
 *
 * ── 为什么用静态结构断言而不是渲染 ─────────────────────────────────
 * `app/admin/layout.tsx` 是 `.tsx`，含 JSX，`node --test` 不转译 JSX
 * （与 `p3-wiring.test.ts` / `p5-wiring.test.ts` 是同一个限制），所以无法
 * `import` 进来真渲染。可选的两条路：
 *
 *   a) 引入一个 JSX 转换器 —— 为了一个测试文件加构建依赖，不值得；
 *   b) **括号配对做结构分析** —— 不依赖行尾/缩进/注释，能定位「哪一句在哪个
 *      `if` 块里」「谁在谁之前」。
 *
 * 这里选 b，但刻意不用「文本里出现过 `redirect("/login")` 就算过」这种扫描 ——
 * P6 报告里 `P6-A3` 的空转就是这么来的（词出现在注释里也绿）。本文件的每条
 * 断言都先 `stripComments()` 再按**括号配对**取块，并且都配了反向守卫。
 *
 * ── 它守不住什么（诚实清单）────────────────────────────────────────
 * 静态分析证明「代码结构正确」，不证明「运行时真的跳转」。运行时行为由
 * `admin-actions.test.ts`（真实调用 action）+ 真实 HTTP 验收
 * （`/admin` → 307 → `/login`，P6 已实测 5 条路由）共同覆盖。
 *
 * 跑法：`node --test-isolation=none apps/web/src/lib/admin/__tests__/admin-guard.test.ts`
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

/** `apps/web/src`（本文件在 `src/lib/admin/__tests__/` 下，往上三层）。 */
const SRC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
/** `apps/web`。 */
const WEB_DIR = resolvePath(SRC_DIR, "..");
/** 仓库根 `loxander-platform`。 */
const REPO_DIR = resolvePath(WEB_DIR, "..", "..");

const ADMIN_LAYOUT = join(SRC_DIR, "app", "admin", "layout.tsx");
const ADMIN_APP_DIR = join(SRC_DIR, "app", "admin");

/* -------------------------------------------------------------------------- */
/* 工具：剥注释 + 括号配对                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 把注释替换成等长空白（保留换行，行号不漂）。
 *
 * 三个坑（都在 P6 踩过，写在这里防止后人重复）：
 * 1. JSX 注释 `{/* … *\/}` 里含 `/*` 与 `*\/`，必须**先**处理，否则
 *    `/* … *\/` 的正则会从 JSX 注释的 `/*` 开始吃，把真实代码一起吃掉。
 * 2. 行注释 `//` 前面若是 `:`（`https://`）或 `\`（转义），不是注释。
 * 3. 替换必须是**等长空白**而不是删掉：删掉会让后续按 offset 取的代码错位。
 */
function stripComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (whole, lead: string) => lead + blank(whole.slice(lead.length)));
}

/**
 * 从 `source[start]`（必须指向 `{` / `(` / `[`）开始做括号配对，返回配对字符的下标。
 * 跳过字符串字面量与模板字符串。找不到返回 -1。
 */
function matchBracket(source: string, start: number): number {
  const open = source[start];
  const close = open === "{" ? "}" : open === "(" ? ")" : open === "[" ? "]" : "";
  if (close === "") return -1;

  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;

  for (let i = start; i < source.length; i += 1) {
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
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * 取出名为 `name` 的函数声明本体（含首尾花括号），找不到返回 `null`。
 *
 * 用括号配对而不是正则按行尾收尾 —— `a11y-audit.test.ts` 的 `extractDeclBody()`
 * 注释里记了完整教训（CRLF + 剥注释后的空行会让 `\n\n` 收尾彻底失效）。
 */
function functionBody(source: string, name: string): string | null {
  const declRe = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const decl = declRe.exec(source);
  if (decl === null) return null;

  // 从参数括号往后找第一个函数体的 `{`（跳过参数列表本身）。
  const paramsStart = decl.index + decl[0].length - 1;
  const paramsEnd = matchBracket(source, paramsStart);
  if (paramsEnd === -1) return null;

  const bodyStart = source.indexOf("{", paramsEnd);
  if (bodyStart === -1) return null;
  const bodyEnd = matchBracket(source, bodyStart);
  if (bodyEnd === -1) return null;

  return source.slice(bodyStart, bodyEnd + 1);
}

/** 取出所有 `if (<cond>) { … }` 块：条件文本 + 块本体。 */
function collectIfBlocks(body: string): { condition: string; block: string; at: number }[] {
  const out: { condition: string; block: string; at: number }[] = [];
  const ifRe = /\bif\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = ifRe.exec(body)) !== null) {
    const condStart = match.index + match[0].length - 1;
    const condEnd = matchBracket(body, condStart);
    if (condEnd === -1) continue;

    const blockStart = body.indexOf("{", condEnd);
    if (blockStart === -1) continue;
    const blockEnd = matchBracket(body, blockStart);
    if (blockEnd === -1) continue;

    out.push({
      condition: body.slice(condStart + 1, condEnd).trim(),
      block: body.slice(blockStart, blockEnd + 1),
      at: match.index,
    });
  }

  return out;
}

/** 首次出现 `needle` 的下标，找不到返回 -1。 */
function indexOfOr(source: string, needle: string): number {
  return source.indexOf(needle);
}

/* -------------------------------------------------------------------------- */
/* 0. 前置：文件存在                                                           */
/* -------------------------------------------------------------------------- */

test("G0：后台布局文件存在，且是默认导出的布局组件", () => {
  assert.ok(existsSync(ADMIN_LAYOUT), `找不到 ${ADMIN_LAYOUT}`);

  const source = stripComments(readFileSync(ADMIN_LAYOUT, "utf8"));
  assert.match(
    source,
    /export\s+default\s+function\s+AdminLayout\s*\(/,
    "app/admin/layout.tsx 必须默认导出一个布局组件（否则 /admin 整棵树没有外层）",
  );
});

/* -------------------------------------------------------------------------- */
/* 1. 守卫真的被挂上（而不是定义了却没人用）                                     */
/* -------------------------------------------------------------------------- */

test("G1：AdminLayout 渲染树里真的用了 <AdminGuard> 包住 children", () => {
  const source = stripComments(readFileSync(ADMIN_LAYOUT, "utf8"));
  const layoutBody = functionBody(source, "AdminLayout");
  assert.ok(layoutBody !== null, "找不到 AdminLayout 的函数体");

  // 定义了 AdminGuard 但 AdminLayout 不渲染它 = 守卫形同虚设。
  // 这条是「删除整行」类变异的兜底：删掉 <AdminGuard> 只剩 {children} 时这里会红。
  assert.match(
    layoutBody,
    /<AdminGuard\b/,
    "AdminLayout 里没有渲染 <AdminGuard> —— 守卫定义了却没挂上，/admin 直接裸奔",
  );
  assert.match(
    layoutBody,
    /\{children\}/,
    "AdminLayout 里没有把 {children} 交给 AdminGuard —— 子页面会绕过守卫",
  );

  // children 必须在 AdminGuard 内部：`<AdminGuard …>{children}</AdminGuard>`
  const guardOpen = layoutBody.indexOf("<AdminGuard");
  const childrenAt = layoutBody.indexOf("{children}");
  const guardClose = layoutBody.indexOf("</AdminGuard>");
  assert.ok(guardOpen !== -1 && guardClose !== -1, "AdminGuard 不是成对标签");
  assert.ok(
    guardOpen < childrenAt && childrenAt < guardClose,
    "{children} 不在 <AdminGuard> … </AdminGuard> 之间 —— 页面内容会绕过守卫渲染",
  );
});

/* -------------------------------------------------------------------------- */
/* 2. 守卫本体：先取会话，再按会话决定跳转                                       */
/* -------------------------------------------------------------------------- */

test("G2：AdminGuard 先 await getAdminSession()，再判断并 redirect", () => {
  const source = stripComments(readFileSync(ADMIN_LAYOUT, "utf8"));
  const guardBody = functionBody(source, "AdminGuard");
  assert.ok(guardBody !== null, "找不到 AdminGuard 的函数体（函数被改名或删了）");

  // ① 必须先取会话。注意 `await` 是必须的：`getAdminSession()` 返回 Promise，
  //    漏掉 await 会让 `session` 变成 truthy 的 Promise，`!session?.user?.id`
  //    恒为 false —— 守卫变成「谁都能进」，而类型系统不会报错。
  assert.match(
    guardBody,
    /await\s+getAdminSession\s*\(\s*\)/,
    "AdminGuard 里没有 `await getAdminSession()` —— 漏 await 会让 session 变成 truthy 的 Promise，守卫失效",
  );

  // ② 必须真的 redirect 到 /login。
  assert.match(
    guardBody,
    /redirect\s*\(\s*["']\/login["']\s*\)/,
    'AdminGuard 里没有 redirect("/login") —— 未登录用户会看到后台内容',
  );

  // ③ 顺序：先取会话，后跳转。反过来（先跳转再取会话）等于无条件跳登录页。
  const sessionAt = guardBody.indexOf("await getAdminSession");
  const redirectAt = guardBody.search(/redirect\s*\(\s*["']\/login["']\s*\)/);
  assert.ok(sessionAt !== -1 && redirectAt !== -1, "取会话或跳转缺失");
  assert.ok(
    sessionAt < redirectAt,
    "redirect 出现在 await getAdminSession() 之前 —— 会变成无条件跳登录页",
  );
});

test("G3：redirect 必须被「会话为空」的条件包住，不能裸奔也不能被包反", () => {
  const source = stripComments(readFileSync(ADMIN_LAYOUT, "utf8"));
  const guardBody = functionBody(source, "AdminGuard");
  assert.ok(guardBody !== null, "找不到 AdminGuard 的函数体");

  const blocks = collectIfBlocks(guardBody);
  const redirectBlock = blocks.find((block) => /redirect\s*\(\s*["']\/login["']\s*\)/.test(block.block));

  // ① 必须存在这样一个 if 块。
  assert.ok(
    redirectBlock !== undefined,
    'redirect("/login") 不在任何 if 块里 —— 它要么是裸奔（所有人都被踢去登录页），要么根本不存在',
  );

  // ② 条件必须是「取反」：`!session?.user?.id` / `session == null` / `!session`
  //    之类。写成 `if (session)` 就变成「已登录才踢出去」，是最坏的一种写反。
  const cond = redirectBlock.condition;
  const looksNegated =
    /!\s*session/.test(cond) ||
    /session\s*===?\s*(?:null|undefined)/.test(cond) ||
    /(?:null|undefined)\s*===?\s*session/.test(cond);
  assert.ok(
    looksNegated,
    `redirect("/login") 的 if 条件不是「会话为空」的取反写法（实际 \`${cond}\`）—— ` +
      "若写成 `if (session)` 就是「已登录才踢出去」，守卫完全反向",
  );

  // ③ 反向守卫：整段 AdminGuard 里不许出现 `if (session)` 这种正向写法。
  assert.ok(
    !/\bif\s*\(\s*session\s*\)/.test(guardBody),
    "AdminGuard 里出现了 `if (session)` —— 这是把守卫写反了（已登录才拒绝）",
  );

  // ④ 不许用 notFound() 顶替 redirect：方案 §9.1 要求「显示无权访问并清除会话」，
  //    对未登录者应当跳登录页，返回 404 会让用户以为地址写错。
  assert.ok(
    !/\bnotFound\s*\(/.test(guardBody),
    "AdminGuard 里用了 notFound() —— 未登录应跳 /login（方案 §9.1），而不是伪装成 404",
  );
});

/* -------------------------------------------------------------------------- */
/* 3. import 来源正确（防同名函数）                                             */
/* -------------------------------------------------------------------------- */

test("G4：redirect 来自 next/navigation，connection 来自 next/server", () => {
  const source = stripComments(readFileSync(ADMIN_LAYOUT, "utf8"));

  assert.match(
    source,
    /import\s*\{[^}]*\bredirect\b[^}]*\}\s*from\s*["']next\/navigation["']/,
    "redirect 必须从 next/navigation 导入 —— 自己写的同名函数不会中断渲染",
  );
  assert.match(
    source,
    /import\s*\{[^}]*\bconnection\b[^}]*\}\s*from\s*["']next\/server["']/,
    "connection 必须从 next/server 导入",
  );
  assert.match(
    source,
    /import\s*\{[^}]*\bgetAdminSession\b[^}]*\}\s*from\s*["']@\/lib\/auth["']/,
    "getAdminSession 必须来自 @/lib/auth（换成别处的同名函数就等于换了守卫判据）",
  );

  // `connection()` 必须在 `getAdminSession()` 之前：auth() 内部生成 CSRF token
  // 会调 crypto.getRandomValues()，开了 cacheComponents 后预渲染阶段会报
  // blocking-prerender-crypto。顺序反了 dev/build 都会告警。
  const connAt = source.indexOf("await connection()");
  const sessionAt = source.indexOf("await getAdminSession()");
  assert.ok(connAt !== -1, "AdminGuard 里没有 await connection()");
  assert.ok(
    connAt < sessionAt,
    "await connection() 必须排在 await getAdminSession() 之前（否则预渲染阶段碰 crypto 会告警）",
  );
});

/* -------------------------------------------------------------------------- */
/* 4. 覆盖性：所有 /admin 页面都在这一层守卫之下                                 */
/* -------------------------------------------------------------------------- */

test("G5：所有 /admin/** 页面都位于 app/admin 之下，没有平行目录绕过守卫", () => {
  // Next 的 layout 只对它自己的目录子树生效。若哪天有人新建
  // `app/(admin)/xxx/page.tsx`（路由组）或 `app/adminXxx/`，
  // 那些页面就**不在** app/admin/layout.tsx 的守卫之下。
  const entries = readdirSync(join(SRC_DIR, "app"), { withFileTypes: true });

  const suspicious = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      if (name === "admin") return false;
      // 路由组 `(xxx)` 或名字里带 admin 的目录都要人工确认。
      if (name.startsWith("(") && name.endsWith(")")) {
        return existsSync(join(SRC_DIR, "app", name, "admin"));
      }
      return /admin/i.test(name);
    });

  assert.deepEqual(
    suspicious,
    [],
    `app/ 下出现了可能绕过 app/admin/layout.tsx 守卫的目录：${suspicious.join(", ")}`,
  );

  // app/admin 目录本身必须存在且有 page.tsx（后台首页）。
  assert.ok(existsSync(join(ADMIN_APP_DIR, "page.tsx")), "app/admin/page.tsx 不存在");
});

/* -------------------------------------------------------------------------- */
/* 5. 反向守卫：注释里写了不算数                                                 */
/* -------------------------------------------------------------------------- */

test("G6：守卫是真实代码，不是注释里的说明（剥注释后才断言）", () => {
  const raw = readFileSync(ADMIN_LAYOUT, "utf8");
  const stripped = stripComments(raw);

  // 这条验证 stripComments 本身有效：原始文件里确实有提到 redirect 的注释，
  // 剥完之后那些字样必须消失。若 stripComments 退化成恒等函数，
  // G2/G3 就会把注释里的字样当成真代码 —— 那正是 P6 报告里 P6-A3 的空转模式。
  assert.ok(
    raw.includes("redirect"),
    "原始文件里连 redirect 字样都没有 —— 守卫真的没了",
  );
  assert.ok(
    stripped.length === raw.length,
    "stripComments 必须等长替换（否则后续按 offset 取代码会错位）",
  );

  const commentMentions = (raw.match(/redirect/g) ?? []).length;
  const codeMentions = (stripped.match(/redirect/g) ?? []).length;
  assert.ok(
    codeMentions >= 1,
    "剥掉注释后没有 redirect 了 —— 守卫只写在注释里，代码里没有",
  );
  assert.ok(
    codeMentions < commentMentions,
    `剥注释没有减少任何 redirect 出现次数（注释 ${commentMentions} 次 / 代码 ${codeMentions} 次）` +
          " —— stripComments 可能失效了，G2/G3 的断言会变成对注释的断言",
  );
});
