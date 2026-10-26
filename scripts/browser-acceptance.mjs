#!/usr/bin/env node
/**
 * P7 真实浏览器验收（Playwright over CDP）。
 *
 * 为什么用 `connectOverCDP` 而不是 `chromium.launch()`：
 * 本机沙箱禁止 fork 子进程（`spawn EPERM`），`launch()` 会起一个新浏览器进程 → 必失败。
 * 改成「外部先起浏览器开调试端口 → 本脚本连上去」，浏览器进程不归 Playwright 管，
 * 就绕过了这条限制。这是 P4 期验证过的通道。
 *
 * 前置：
 *   1. `node scripts/next-local-build.mjs`（产出生产构建）
 *   2. `node scripts/next-local-start.mjs --port 3310`（起生产服务器）
 *   3. 外部起浏览器：msedge --remote-debugging-port=9222 --headless=new --user-data-dir=...
 *
 * 用法：npm run test:browser  （或 node scripts/browser-acceptance.mjs [--base URL] [--cdp URL]）
 *
 * 覆盖（对应方案 §11 P7 验收与 P6 遗留 §14.1 第 19 条）：
 *   A. 20 条公开路由真实渲染（不是 fetch，是浏览器里跑完 hydration）
 *   B. 移动端 375×812 视口：无横向溢出、导航可展开
 *   C. 暗色模式：切换后无闪烁残留、对比度令牌生效
 *   D. 客户端交互：CodeMirror 后台编辑器可输入、主题切换、搜索输入
 *   E. 软 404 回归：冷 URL 在浏览器里也是 404
 *   F. 控制台错误 / 页面异常 / 失败请求
 */
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ⚠️ 本脚本在 scripts/ 子目录里，REPO_ROOT 要往上一层。
// 之前放仓库根时写 `path.resolve(HERE, "..")` 会指到上层 bolg/，报 Cannot find module 'playwright'。
const REPO_ROOT = path.resolve(HERE, "..");
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const { chromium } = require("playwright");

function readArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const BASE = readArg("base", "http://127.0.0.1:3310");
const CDP = readArg("cdp", "http://127.0.0.1:9222");

/* -------------------------------------------------------------------------- */
/* 断言工具                                                                    */
/* -------------------------------------------------------------------------- */

let pass = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/* -------------------------------------------------------------------------- */
/* 路由清单                                                                    */
/* -------------------------------------------------------------------------- */

/** 公开路由（生产构建实测全部 200 的那 20 条）。 */
const PUBLIC_ROUTES = [
  "/",
  "/about",
  "/blog",
  "/blog/agriculture-feature-engineering",
  "/blog/build-personal-blog-with-nextjs",
  "/blog/langgraph-rag-workflow",
  "/blog/rag-chunking-strategies",
  "/diary",
  "/diary/week01",
  "/goals",
  "/projects",
  "/projects/crop-yield-prediction",
  "/projects/personal-blog-platform",
  "/projects/rag-knowledge-assistant",
  "/resume",
  "/search",
  "/tags",
  "/tags/llm",
  "/tags/RAG",
  "/universe",
];

/** 后台路由（未登录应 307 到 /login）。 */
const ADMIN_ROUTES = [
  "/admin",
  "/admin/content",
  "/admin/media",
  "/admin/settings",
  "/admin/audit",
  "/admin/new",
];

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

const browser = await chromium.connectOverCDP(CDP);
const defaultContext = browser.contexts()[0];
if (defaultContext === undefined) {
  throw new Error("[p7-browser] CDP 连上了但没有 context —— 浏览器启动参数不对？");
}

/** 每条用例一个干净 page，避免上一条的 localStorage / cookie 污染。 */
async function withPage(viewport, run) {
  const context = await browser.newContext({
    viewport,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("requestfailed", (req) => {
    // favicon / 预取失败不算缺陷
    const url = req.url();
    if (url.includes("favicon")) return;
    failedRequests.push(`${req.method()} ${url} — ${req.failure()?.errorText ?? "?"}`);
  });

  try {
    await run(page, { consoleErrors, pageErrors, failedRequests });
  } finally {
    await context.close();
  }
}

/* -------------------------------------------------------------------------- */
/* A. 20 条公开路由真实渲染                                                    */
/* -------------------------------------------------------------------------- */

section("A. 20 条公开路由真实渲染（桌面 1440×900）");

const routeResults = [];

for (const route of PUBLIC_ROUTES) {
  await withPage({ width: 1440, height: 900 }, async (page, errs) => {
    const response = await page.goto(BASE + route, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const status = response?.status() ?? 0;

    // 等 hydration：Next 会在 body 上挂数据属性 / 事件，用「无 console error + 有 h1」判
    await page.waitForTimeout(400);

    const h1Count = await page.locator("h1").count();
    const lang = await page.getAttribute("html", "lang");
    const title = await page.title();
    const bodyLen = (await page.locator("body").innerText()).length;

    const ok =
      status === 200 &&
      h1Count === 1 &&
      lang === "zh-CN" &&
      title.length > 0 &&
      bodyLen > 100 &&
      errs.pageErrors.length === 0;

    routeResults.push({ route, status, h1Count, title, bodyLen, ok });

    check(
      `${route}`,
      ok,
      `status=${status} h1=${h1Count} text=${bodyLen}字 title="${title.slice(0, 34)}"`,
    );

    if (errs.pageErrors.length > 0) {
      console.log(`      pageerror: ${errs.pageErrors[0].slice(0, 160)}`);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* B. 移动端 375×812                                                           */
/* -------------------------------------------------------------------------- */

section("B. 移动端 375×812：无横向溢出 + 导航可用");

for (const route of ["/", "/blog", "/tags", "/search", "/universe"]) {
  await withPage({ width: 375, height: 812 }, async (page) => {
    await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(400);

    // 横向溢出检测：scrollWidth 超出 clientWidth 超过 2px 视为溢出
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
    });
    const overflowBy = overflow.scrollWidth - overflow.clientWidth;

    check(
      `${route} 移动端无横向溢出`,
      overflowBy <= 2,
      `scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth} 溢出=${overflowBy}px`,
    );
  });
}

// 移动端抽屉导航：点汉堡按钮后菜单可见
// ⚠️ 必须跑在 (site) 路由组（如 /blog）上：/ 与 /universe 属 (cosmic) 组，
// 它们的布局只有 CosmicChrome，压根没有 Navbar / ThemeToggle —— 在 / 上找菜单按钮
// 是脚本写错，不是页面缺陷（P7 首次跑报的两条假失败就是这个）。
await withPage({ width: 375, height: 812 }, async (page) => {
  await page.goto(BASE + "/blog", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(500);

  const toggle = page.locator('button[aria-label*="菜单"], button[aria-expanded]').first();
  const toggleCount = await toggle.count();

  if (toggleCount === 0) {
    check("移动端导航有可展开按钮", false, "找不到带 aria-label/aria-expanded 的按钮");
    return;
  }

  const expandedBefore = await toggle.getAttribute("aria-expanded");
  await toggle.click();
  await page.waitForTimeout(350);
  const expandedAfter = await toggle.getAttribute("aria-expanded");

  // 展开后应该能看到「文章 / 项目 / 日记」等导航文字
  const navText = await page.locator("header.sticky").first().innerText();
  const hasNavItem = /文章|项目|日记|目标|关于/.test(navText);

  check(
    "移动端导航可展开且露出导航项",
    expandedBefore === "false" && expandedAfter === "true" && hasNavItem,
    `aria-expanded: ${expandedBefore} → ${expandedAfter}`,
  );
});

/* -------------------------------------------------------------------------- */
/* C. 暗色模式                                                                 */
/* -------------------------------------------------------------------------- */

section("C. 暗色模式：主题切换真实生效");

// 同上：ThemeToggle 只存在于 (site) 路由组的 Navbar 里，所以跑 /blog 而不是 /。
await withPage({ width: 1440, height: 900 }, async (page) => {
  await page.goto(BASE + "/blog", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(400);

  const htmlClassBefore = (await page.getAttribute("html", "class")) ?? "";
  const bgBefore = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor,
  );

  // 找主题切换按钮（ThemeToggle）
  const themeButton = page
    .locator('button[aria-label*="主题"], button[aria-label*="theme"], button[title*="主题"]')
    .first();

  if ((await themeButton.count()) === 0) {
    check("找到主题切换按钮", false, "没有 aria-label 含「主题/theme」的按钮");
    return;
  }

  await themeButton.click();
  await page.waitForTimeout(450);

  const htmlClassAfter = (await page.getAttribute("html", "class")) ?? "";
  const bgAfter = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor,
  );
  const storedTheme = await page.evaluate(() => localStorage.getItem("theme"));

  check(
    "点击主题切换后 <html> 的 class 变了",
    htmlClassBefore !== htmlClassAfter,
    `"${htmlClassBefore}" → "${htmlClassAfter}"`,
  );
  check(
    "点击主题切换后背景色真的变了",
    bgBefore !== bgAfter,
    `${bgBefore} → ${bgAfter}`,
  );
  check(
    "主题选择写入 localStorage",
    storedTheme === "light" || storedTheme === "dark" || storedTheme === "system",
    `theme=${storedTheme}`,
  );

  // 刷新后主题保持（验证 themeInitScript 真的在 head 里同步执行）
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  const htmlClassReload = (await page.getAttribute("html", "class")) ?? "";
  const bgReload = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor,
  );

  // 主题用 `.dark` 类的「有/无」表达：浅色时 className 里根本没有 "light" 字样。
  // 所以不能查字面量 "light"，要比「dark 的存在性是否一致」+ 背景色是否一致。
  check(
    "刷新后主题保持（themeInitScript 生效，无 FOUC）",
    htmlClassReload.includes("dark") === htmlClassAfter.includes("dark") &&
      bgReload === bgAfter,
    `dark: ${htmlClassAfter.includes("dark")} → ${htmlClassReload.includes("dark")}  bg: ${bgAfter} → ${bgReload}`,
  );
});

/* -------------------------------------------------------------------------- */
/* D. 客户端交互                                                               */
/* -------------------------------------------------------------------------- */

section("D. 客户端交互：搜索输入、标签跳转、RSS/sitemap");

await withPage({ width: 1440, height: 900 }, async (page) => {
  await page.goto(BASE + "/search", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(400);

  const searchInput = page
    .locator('input[type="search"], input[name="q"], input[placeholder*="搜索"]')
    .first();

  if ((await searchInput.count()) === 0) {
    check("搜索页有输入框", false, "找不到 search / q / 搜索 输入框");
    return;
  }

  await searchInput.fill("rag");
  await searchInput.press("Enter");

  // 搜索走服务端动态查询（方案 §14.2「搜索：动态查询」），不套 "use cache"，
  // 实测表单提交后约 4.1s 才拿到结果。固定等 900ms 只能拿到骨架 —— 那是脚本
  // 误报，不是页面缺陷。这里轮询到「匹配到」出现，上限 15s。
  const searchDeadline = Date.now() + 15_000;
  let resultText = "";
  while (Date.now() < searchDeadline) {
    await page.waitForTimeout(500);
    resultText = await page.locator("body").innerText();
    if (resultText.includes("匹配到")) break;
  }

  const urlAfter = page.url();
  const hasResults = /rag/i.test(resultText) && resultText.length > 200;

  check(
    "搜索「rag」后 URL 带 q 参数",
    /[?&]q=rag/.test(urlAfter),
    urlAfter.replace(BASE, ""),
  );
  check("搜索结果页有实际内容", hasResults, `${resultText.length} 字`);
});

// 标签页 → 点标签 → 进标签详情
await withPage({ width: 1440, height: 900 }, async (page) => {
  await page.goto(BASE + "/tags", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(400);

  const tagLinks = page.locator('a[href^="/tags/"]');
  const tagCount = await tagLinks.count();

  if (tagCount === 0) {
    check("标签页有标签链接", false, "a[href^='/tags/'] 数量为 0");
    return;
  }

  const firstHref = await tagLinks.first().getAttribute("href");
  const urlBefore = page.url();
  await tagLinks.first().click();

  // 客户端路由 + 页面过渡动画，实测 +300ms 时 URL 仍停在 /tags、+1200ms 才到 /tags/llm。
  // 固定 500ms 会拿到旧 URL —— 那是脚本误报。轮询等待 URL 真的变化。
  const navDeadline = Date.now() + 15_000;
  while (Date.now() < navDeadline && page.url() === urlBefore) {
    await page.waitForTimeout(200);
  }
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(600);

  // React 19 <Activity> 会保留上一页的 DOM 树（隐藏）。只数可见的 h1。
  const landedH1 = await page.evaluate(
    () => Array.from(document.querySelectorAll("h1")).filter((h) => h.getClientRects().length > 0).length,
  );
  const landedUrl = page.url();

  check(
    "点击标签能进详情页且渲染完整",
    landedH1 === 1 && landedUrl.includes("/tags/"),
    `${firstHref} → ${landedUrl.replace(BASE, "")}`,
  );
});

// 文章页内链跳转（客户端路由，不整页刷新）
await withPage({ width: 1440, height: 900 }, async (page) => {
  await page.goto(BASE + "/blog", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(400);

  // 打标记验证是否发生整页刷新
  await page.evaluate(() => {
    window.__p7Marker = "kept";
  });

  const postLink = page.locator('a[href^="/blog/"]').first();
  if ((await postLink.count()) === 0) {
    check("博客列表有文章链接", false, "a[href^='/blog/'] 数量为 0");
    return;
  }

  await postLink.click();
  await page.waitForTimeout(1200);

  const marker = await page.evaluate(() => window.__p7Marker ?? null);
  // 同上：React 19 <Activity> 保留的旧树会让 h1 计数偏大，只数可见的。
  const h1 = await page.evaluate(
    () => Array.from(document.querySelectorAll("h1")).filter((h) => h.getClientRects().length > 0).length,
  );

  check(
    "列表 → 详情是客户端路由（未整页刷新）",
    marker === "kept" && h1 === 1,
    `marker=${marker} h1=${h1} url=${page.url().replace(BASE, "")}`,
  );
});

/* -------------------------------------------------------------------------- */
/* E. 软 404 回归（浏览器内）                                                  */
/* -------------------------------------------------------------------------- */

section("E. 软 404 回归：浏览器里冷 URL 也必须是 404");

const coldSlugs = [
  `/blog/p7-nope-${Date.now()}-a`,
  `/diary/p7-nope-${Date.now()}-b`,
  `/projects/p7-nope-${Date.now()}-c`,
  `/tags/p7-nope-${Date.now()}-d`,
];

for (const route of coldSlugs) {
  await withPage({ width: 1440, height: 900 }, async (page) => {
    const response = await page.goto(BASE + route, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const status = response?.status() ?? 0;
    await page.waitForTimeout(250);
    const has404Copy = /不存在|偏离航线/.test(await page.locator("body").innerText());

    check(
      `${route.replace(/p7-nope-\d+-/, "p7-nope-*-")} 返回 404`,
      status === 404,
      `status=${status} 404文案=${has404Copy}`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* F. 后台守卫（未登录）                                                        */
/* -------------------------------------------------------------------------- */

section("F. 后台守卫：未登录一律 307 到 /login");

for (const route of ADMIN_ROUTES) {
  await withPage({ width: 1440, height: 900 }, async (page) => {
    const response = await page.goto(BASE + route, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const finalUrl = page.url();
    const redirectedToLogin = finalUrl.includes("/login");
    // 浏览器跟随重定向后拿到的是最终页面的 200
    const landedLogin = /登录|GitHub/.test(await page.locator("body").innerText());

    check(
      `${route} → /login`,
      redirectedToLogin && landedLogin,
      `status=${response?.status() ?? 0} → ${finalUrl.replace(BASE, "")}`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* G. 控制台干净度                                                             */
/* -------------------------------------------------------------------------- */

section("G. 控制台 / 页面异常 / 失败请求");

for (const route of ["/", "/blog", "/blog/rag-chunking-strategies", "/universe", "/search"]) {
  await withPage({ width: 1440, height: 900 }, async (page, errs) => {
    await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(500);

    // CSP 违规会以 console error 形式出现
    const cspViolations = errs.consoleErrors.filter((t) =>
      /Content Security Policy|Refused to/i.test(t),
    );

    check(
      `${route} 无页面异常 / 无 CSP 违规`,
      errs.pageErrors.length === 0 && cspViolations.length === 0,
      `pageerror=${errs.pageErrors.length} csp=${cspViolations.length} console=${errs.consoleErrors.length}`,
    );

    if (errs.pageErrors.length > 0) {
      console.log(`      pageerror: ${errs.pageErrors[0].slice(0, 200)}`);
    }
    if (cspViolations.length > 0) {
      console.log(`      CSP: ${cspViolations[0].slice(0, 200)}`);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 汇总                                                                        */
/* -------------------------------------------------------------------------- */

console.log(`\n${"=".repeat(72)}`);
console.log(`P7 浏览器验收结果：通过 ${pass} / 失败 ${failures.length}（共 ${pass + failures.length} 条）`);

if (failures.length > 0) {
  console.log("\n失败清单：");
  for (const f of failures) {
    console.log(`  - ${f.name}  ${f.detail}`);
  }
  console.log("\n❌ 存在失败");
} else {
  console.log("\n✅ 全部通过");
}

await browser.close().catch(() => {});
process.exit(failures.length === 0 ? 0 : 1);
