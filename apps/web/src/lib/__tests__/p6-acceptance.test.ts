/**
 * P6 全流程等价验收套件。
 *
 * ── 这个文件解决什么问题 ──────────────────────────────────────────────────
 * 方案 §11 P6 要求「执行 Playwright 全流程」「对比旧站点与预览站点」。
 * 本机做不到：没有 Playwright（`node_modules/playwright`、`@playwright/test`
 * 都不存在），沙箱禁止 fork 子进程（`next build` / 默认 `next dev` /
 * `vitest` 全部 `spawn EPERM`），也拿不到 Neon preview 分支与 Vercel Preview
 * 环境（需要云端账号与网络）。
 *
 * 所以这里做的是**等价验收**：把「全流程能不能走通」「新旧 URL 是否等价」
 * 这类问题，转成对**真实源码 + 真实内容文件 + 真实数据库映射逻辑**的断言。
 *
 * ── 等价手段证明不了什么（必须写清楚，不能含糊） ─────────────────────────
 * 1. 证明不了「浏览器里真的能点」：React 运行时、事件绑定、水合错误全都不覆盖。
 * 2. 证明不了「视觉正确」：布局、溢出、对比度、响应式断点的实际效果都不覆盖。
 * 3. 证明不了「真实数据库/真实 Blob 可用」：这里用的是 PGlite（内存 Postgres）
 *    与文件系统，不是 Neon 与 Vercel Blob。
 * 4. 证明不了「生产构建产物可用」：`next build` 从未在本机跑通。
 * 这四条写在 `P6验收报告.md` 的「等价手段证明不了什么」一节里，
 * **不允许把它们写成「验收通过」**。
 *
 * ── 为什么要断言源码而不是导入源码求值 ───────────────────────────────────
 * 页面组件是 React Server Components，导入它们需要 `next` 运行时、
 * `server-only` 桩、`next/cache` 桩等一整套替身，且大量组件依赖
 * `await headers()` / `cookies()` 这类请求上下文。用正则扫源码虽然「不够
 * 优雅」，但它断言的是**结构约定**（有没有 canonical、有没有 requireAdmin、
 * 有没有乐观锁），这类约定本来就不该靠运行时行为来验证 —— 运行时行为是
 * `admin-actions.test.ts` 与 `p5-e2e.test.ts` 的职责，不是这里的。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

/* -------------------------------------------------------------------------- */
/* 1. 路径                                                                     */
/* -------------------------------------------------------------------------- */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `apps/web/src/lib/__tests__` → 三层上溯到 `apps/web` */
const APP_WEB_ROOT = path.resolve(HERE, "../../..");
const REPO_ROOT = path.resolve(APP_WEB_ROOT, "../..");
const SRC_ROOT = path.join(APP_WEB_ROOT, "src");
const APP_ROOT = path.join(SRC_ROOT, "app");
const CONTENT_ROOT = path.join(APP_WEB_ROOT, "content");

/** 递归列出目录下指定扩展名的文件（绝对路径）。 */
function walk(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const info = statSync(full);

    if (info.isDirectory()) {
      found.push(...walk(full, extensions));
      continue;
    }

    if (extensions.some((extension) => entry.endsWith(extension))) {
      found.push(full);
    }
  }

  return found;
}

/** 相对 `SRC_ROOT` 的 posix 风格路径，用于断言消息里好读。 */
function relativeToSrc(absolute: string): string {
  return path.relative(SRC_ROOT, absolute).split(path.sep).join("/");
}

const ALL_TSX = walk(SRC_ROOT, [".tsx"]);
const ALL_TS = walk(SRC_ROOT, [".ts"]);
const ALL_SOURCE = [...ALL_TSX, ...ALL_TS];

/* -------------------------------------------------------------------------- */
/* A. 路由与页面清单完整性                                                      */
/* -------------------------------------------------------------------------- */

/** 从 app 目录树推出路由路径（去掉路由组括号、去掉 page.tsx）。 */
function routeOf(pageFile: string): string {
  const relative = path.relative(APP_ROOT, pageFile).split(path.sep).join("/");
  const withoutFile = relative.replace(/\/page\.tsx$/, "").replace(/^page\.tsx$/, "");
  const withoutGroups = withoutFile
    .split("/")
    .filter((segment) => segment.length > 0 && !/^\(.*\)$/.test(segment))
    .join("/");

  return `/${withoutGroups}`;
}

test("P6-A1 公开路由清单与预期一致（新增/删除页面必须显式更新本测试）", () => {
  const pageFiles = walk(APP_ROOT, ["page.tsx"]);

  const publicRoutes = pageFiles
    .map((file) => routeOf(file))
    .filter((route) => !route.startsWith("/admin") && !route.startsWith("/login"))
    .sort();

  /*
    这份清单是**契约**，不是「现状快照」。
    删掉一个页面会让搜索引擎留下 404，新增一个页面若忘了加 canonical
    会让 SEO 出现重复内容 —— 两者都该是一次显式决定，而不是 git diff 里
    顺手带过去的一行。所以这里要求清单严格相等。
  */
  const expected = [
    "/",
    "/about",
    "/blog",
    "/blog/[slug]",
    "/diary",
    "/diary/[slug]",
    "/goals",
    "/projects",
    "/projects/[slug]",
    "/resume",
    "/search",
    "/tags",
    "/tags/[tag]",
    "/universe",
  ].sort();

  assert.deepEqual(
    publicRoutes,
    expected,
    "公开路由清单变了。若是有意的增删，请同步更新本测试的 expected 数组，" +
      "并确认新页面有 metadata + canonical、且已加入 sitemap",
  );
});

test("P6-A1b 后台路由清单与预期一致", () => {
  const pageFiles = walk(APP_ROOT, ["page.tsx"]);

  const adminRoutes = pageFiles
    .map((file) => routeOf(file))
    .filter((route) => route.startsWith("/admin") || route.startsWith("/login"))
    .sort();

  assert.deepEqual(
    adminRoutes,
    [
      "/admin",
      "/admin/audit",
      "/admin/content",
      "/admin/content/[kind]/[slug]",
      "/admin/content/[kind]/[slug]/revisions",
      "/admin/media",
      "/admin/new",
      "/admin/settings",
      "/login",
    ].sort(),
    "后台路由清单变了",
  );
});

test("P6-A2 每个公开页面都有 metadata，且都带 canonical（剥注释 + 限定在 metadata 块内）", () => {
  const publicPageFiles = walk(APP_ROOT, ["page.tsx"]).filter((file) => {
    const route = routeOf(file);
    return !route.startsWith("/admin") && !route.startsWith("/login");
  });

  /*
    ══ 原版为什么是空转的（审计报告 A2，已用变异测试证明）════════════════

    原断言是两行**全文件 raw 文本**扫描：

        if (!/alternates/.test(source) || !/canonical/.test(source)) { ... }

    两个致命问题：
      ①**不剥注释**。把 `alternates: { canonical: "/tags" }` 整个搬进注释，
        词还在文件里，两条正则照样命中 → 仍然绿。
      ②**不限定位置**。只要文件里任何地方（import、类型注释、别的 metadata）
        出现过这两个词就算过，等同于没断言。

    变异实测：把 `(site)/tags/page.tsx:42` 的 alternates 行改成注释，原断言
    18/18 全绿。这就是必须改的原因。
  */

  // 根 layout 的 canonical —— 同样要剥注释后再看，否则「注释里写了 canonical」
  // 会让首页被放行。
  const rootLayoutCode = stripComments(readFileSync(path.join(APP_ROOT, "layout.tsx"), "utf8"));
  const rootProvidesCanonical = /alternates:\s*\{[\s\S]*?canonical:\s*["'`]/.test(rootLayoutCode);

  const missingMetadata: string[] = [];
  const missingCanonical: string[] = [];
  /*
    第三类失败单独记账：「metadata 里没有 canonical，但文件别处有」。
    这正是原断言放过的形态 —— 单列出来，变异时会看到它，而不是笼统的
    「没有 canonical」。
  */
  const canonicalOnlyOutsideMetadata: string[] = [];

  for (const file of publicPageFiles) {
    // 先剥注释：之后所有判断只针对真代码。
    const code = stripComments(readFileSync(file, "utf8"));

    /*
      取出「metadata 块」的真代码范围：
        · `export const metadata ... = { ... }`  → 花括号配平取对象
        · `export async function generateMetadata(...) { ... }` → 取函数体
      两者都没有 = 这个页面没导出 metadata。

      注意 generateMetadata 返回的可能是 `{ title: "..." }` 这种**提前返回**
      （如 blog/[slug]/page.tsx:38 的 `if (!post) return { title: "文章不存在" };`），
      所以断言的是「函数体里出现 canonical」而不是「每条 return 都带」。
      这是刻意的：文章不存在时不需要 canonical。
    */
    let metadataBlock: string | null = null;

    const constMatch = /export\s+const\s+metadata\s*:/.exec(code);
    if (constMatch !== null) {
      const braceStart = code.indexOf("{", constMatch.index);
      if (braceStart >= 0) metadataBlock = braceBlock(code, braceStart);
    }

    if (metadataBlock === null) {
      metadataBlock = extractFunctionBody(code, "generateMetadata");
    }

    if (metadataBlock === null) {
      missingMetadata.push(relativeToSrc(file));
      continue;
    }

    /*
      canonical 的**唯一合法形态**：在 metadata 块内、且紧跟 `alternates: {`。

      本仓库 13 个页面的实际写法（2026-10-24 逐个实测）全是这一行式：
        alternates: { canonical: "/universe" },              ← 字面量
        alternates: { canonical: `/blog/${post.slug}` },      ← 模板串
        alternates: { canonical: tagHref(known.tag) },        ← 函数调用
      三种都必须接受，所以右值只校验到 `canonical:` 为止，不校验右值形态
      —— 右值该不该是 tagHref() 由 P6-C11 那条单独守。
    */
    const IN_METADATA = /alternates:\s*\{\s*canonical:/;

    if (IN_METADATA.test(metadataBlock)) continue;

    // 首页特例：canonical 由根 layout 的 metadata 继承提供（Next 的 metadata 继承）。
    if (routeOf(file) === "/" && rootProvidesCanonical) continue;

    // 走到这里说明 metadata 块里没有 canonical。区分两种情形，便于定位。
    if (/canonical/.test(code)) canonicalOnlyOutsideMetadata.push(relativeToSrc(file));
    else missingCanonical.push(relativeToSrc(file));
  }

  assert.deepEqual(missingMetadata, [], "以下公开页面没有导出 metadata");

  /*
    这条是 A2 的核心。它和原断言的区别只有一句：**canonical 必须在
    metadata 块的真代码里**。就这一个差别，让「搬进注释」和「写在别处」
    两种绕过同时失效。
  */
  assert.deepEqual(
    canonicalOnlyOutsideMetadata,
    [],
    "以下页面的 canonical 出现在 metadata 块**之外**（注释里、别的对象里、" +
      "或 import 里）。搜索引擎只认 metadata 导出，写在别处等于没有 canonical，" +
      "会让重复内容被收录。请把 `alternates: { canonical: ... }` 放进 " +
      "`export const metadata` 或 `generateMetadata()` 的返回值里",
  );

  assert.deepEqual(
    missingCanonical,
    [],
    "以下公开页面没有 canonical（会导致重复内容被搜索引擎收录）",
  );
});

test("P6-A3 sitemap 与 robots 一致，后台与搜索页不进 sitemap（去重必须是真代码）", async () => {
  const sitemapRaw = readFileSync(path.join(APP_ROOT, "sitemap.ts"), "utf8");
  const robotsSource = readFileSync(path.join(APP_ROOT, "robots.ts"), "utf8");

  /*
    ══ 为什么要先剥注释（审计报告 A3，变异测试已证明）═══════════════════════

    原版直接对 raw 文本跑 `assert.match(sitemapSource, /mergeTagsByUrl/)`。
    但 `sitemap.ts` 第 10 行就是

        import { mergeTagsByUrl, tagHref } from "@/lib/tag-url";

    只要这行 import 还在，正则就永远命中 —— 哪怕第 70 行真的退化成
    `tags.map(...)`（未去重）。变异实测：换回 `tags.map` 仍是 18/18 全绿。

    注释里也写着 mergeTagsByUrl 的存在理由。所以下面所有判断一律走
    `sitemap`（剥注释版）。`stripComments()` 是等长替换，行号不漂。
  */
  const sitemap = stripComments(sitemapRaw);

  // robots 必须允许全站（否则 sitemap 里列的东西都被 forbid 掉，自相矛盾）
  assert.match(
    robotsSource,
    /allow:\s*"\/"/,
    "robots.ts 必须 allow \"/\"，否则 sitemap 里的 URL 全被禁止抓取",
  );
  assert.match(
    robotsSource,
    /sitemap:\s*`\$\{base\}\/sitemap\.xml`/,
    "robots.ts 必须声明 sitemap 地址",
  );

  // 后台绝不能出现在 sitemap
  assert.ok(
    !/\/admin/.test(sitemap),
    "sitemap.ts 里不能出现 /admin —— 后台是私有的，被收录会把入口暴露给爬虫",
  );
  assert.ok(!/\/login/.test(sitemap), "sitemap.ts 里不能出现 /login");

  // /search 刻意不进 sitemap（P5 决定）：每条 query 都是独立 URL，收录会让爬虫空转。
  // 剥注释之后，「为什么 /search 不进去」那段解释自然不参与匹配，无需再特判。
  assert.ok(
    !/url:\s*`\$\{base\}\/search/.test(sitemap),
    "sitemap.ts 不能把 /search 拼进 url —— 搜索页是无限组合，收录会让爬虫空转",
  );

  /*
    ══ A3 的核心：去重必须出现在 tagRoutes 的**赋值表达式**里 ═══════════════

    为什么不能只匹配 `mergeTagsByUrl` 这个词（见上）。改成两条互补断言：

      ① 正向：`const tagRoutes ... = mergeTagsByUrl(tags).map(` —— 这个调用必须
         是「产出 tagRoutes」的那一步，而不是被 import 进来待用；
      ② 反向：剥注释后的真代码里**不许**出现裸 `tags.map(`。

    两条合起来，任何「去重被绕过」的退化都至少红一条：
    改回 `tags.map` → 第二条红；把去重挪到别处、tagRoutes 直接接 tags → 第一条红。
  */
  assert.match(
    sitemap,
    /const\s+tagRoutes\b[^=]*=\s*mergeTagsByUrl\(\s*tags\s*\)\s*\.map\(/,
    "sitemap.ts 的 `tagRoutes` 必须由 `mergeTagsByUrl(tags).map(...)` 产出。" +
      "仅在 import 里出现 mergeTagsByUrl 不算：未去重的路径会让 \"RAG\" 与 \"rag\" " +
      "产出两条指向同一 URL 的 sitemap 条目，搜索引擎会把它当成重复内容",
  );

  assert.ok(
    !/\btags\.map\(/.test(sitemap),
    "sitemap.ts 的真代码里出现了裸 `tags.map(` —— 这是未去重的形态，" +
      "必须走 `mergeTagsByUrl(tags).map(`。" +
      "（注释里写这个词不算：本断言已经剥过注释）",
  );
});

test("P6-A4 rss.xml 走内容源抽象，不直接读文件系统", () => {
  const rssSource = readFileSync(path.join(APP_ROOT, "rss.xml/route.ts"), "utf8");

  assert.match(
    rssSource,
    /from\s+"@\/lib\/content"/,
    "rss.xml 必须从 @/lib/content 取数（内容源抽象），" +
      "直接读文件系统会让 CONTENT_SOURCE=db 时 RSS 读到旧数据",
  );
  assert.ok(
    !/node:fs|from "fs"/.test(rssSource),
    "rss.xml 不能直接 import node:fs —— 那会绕过 CONTENT_SOURCE 开关",
  );
});

/* -------------------------------------------------------------------------- */
/* B. 内容与 URL 等价                                                          */
/* -------------------------------------------------------------------------- */

test("P6-B5 旧 URL 全覆盖：每个内容文件都能被对应路由的静态参数覆盖", () => {
  /** 各类型的目录与路由前缀（与 apps/web/content 的实际布局一致）。 */
  const kinds = [
    { dir: "blog", route: "/blog", hasStaticParams: true },
    { dir: "diary", route: "/diary", hasStaticParams: true },
    { dir: "projects", route: "/projects", hasStaticParams: true },
    { dir: "goals", route: "/goals", hasStaticParams: false },
  ] as const;

  const problems: string[] = [];

  for (const kind of kinds) {
    const dir = path.join(CONTENT_ROOT, kind.dir);
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch {
      problems.push(`内容目录不存在：content/${kind.dir}`);
      continue;
    }

    if (files.length === 0) problems.push(`content/${kind.dir} 下没有任何 .md`);

    for (const file of files) {
      const slug = file.replace(/\.md$/, "");
      // slug 必须只含 URL 安全字符（与 content-core 的 SLUG_PATTERN 一致）
      if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
        problems.push(`content/${kind.dir}/${file} 的 slug 含 URL 不安全字符`);
      }
      // goals 是单页（无 [slug]），其余必须能通过 [slug] 到达
      if (kind.hasStaticParams) {
        const pageFile = walk(APP_ROOT, ["page.tsx"]).find(
          (candidate) => routeOf(candidate) === `${kind.route}/[slug]`,
        );
        if (!pageFile) {
          problems.push(`${kind.route}/[slug] 路由不存在，${slug} 无法访问`);
          continue;
        }
        const source = readFileSync(pageFile, "utf8");
        if (!/generateStaticParams/.test(source)) {
          problems.push(`${kind.route}/[slug] 没有 generateStaticParams`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], "旧 URL 覆盖存在问题");
});

test("P6-B6 proxy 的 redirects 消费路径正确", () => {
  const proxySource = readFileSync(path.join(SRC_ROOT, "proxy.ts"), "utf8");

  assert.match(
    proxySource,
    /from redirects/,
    "proxy.ts 必须从 redirects 表查重定向",
  );
  assert.match(
    proxySource,
    /STATIC_REDIRECTS/,
    "proxy.ts 必须保留 STATIC_REDIRECTS 作为「表坏了也能救流量」的兜底",
  );

  // STATIC_REDIRECTS 为空 map 时，任何 pathname 查不到 → 返回 null → 放行。
  // 断言空 map 的字面量还在（不是被填了乱七八糟的东西）。
  assert.match(
    proxySource,
    /STATIC_REDIRECTS:\s*Readonly<Record<string,\s*string>>\s*=\s*\{\s*\}/,
    "STATIC_REDIRECTS 当前应为空 map（真实重定向走 redirects 表）",
  );

  // 查表失败必须放行而不是 500（否则数据库抖一下全站 500）
  assert.match(
    proxySource,
    /catch/,
    "proxy.ts 查表失败必须有 catch，且应当放行",
  );
});

test("P6-B7 slug 稳定性：导入不改变 URL（文件名 stem 即 slug）", () => {
  /*
    这条断言的是**契约**而不是实现：`db/mapping.ts` 的 `mapEntry(kind, slug, raw, ctx)`
    里 `slug` 是**入参**，不是从 frontmatter 里读出来的。也就是说
    「slug 从哪来」由调用方（`db/import.ts`）决定，而它用的是文件名 stem。
    所以这里断言的是 `db/import.ts` 确实把文件名 stem 当 slug 传进去 ——
    这比跑一遍 mapEntry 更直接，也不需要在测试里搭一套 gray-matter 环境。
  */
  const importSource = readFileSync(path.join(REPO_ROOT, "db/import.ts"), "utf8");

  assert.match(
    importSource,
    /basename|replace\(\/\\\.md\$\/|\.md"?\s*,\s*""/,
    "db/import.ts 必须从文件名派生 slug（basename 或去掉 .md 后缀）",
  );

  // 不允许从 frontmatter 读 slug 字段（那会让「改文件名」与「改 URL」解耦，
  // 反而破坏「文件名即 URL」这条最稳定的约定）
  assert.ok(
    !/frontmatter\.slug|data\.slug|matter\.slug/.test(importSource),
    "db/import.ts 不能从 frontmatter 读 slug —— 文件名才是 URL 的唯一来源",
  );

  // mapping.ts 的签名里 slug 必须是独立参数（不是从 raw 里解构出来的）
  const mappingSource = readFileSync(path.join(REPO_ROOT, "db/mapping.ts"), "utf8");
  assert.match(
    mappingSource,
    /export function mapEntry\(\s*kind:\s*EntryKind,\s*slug:\s*string,/,
    "mapEntry 的签名必须是 (kind, slug, raw, ctx) —— slug 作为独立入参",
  );
});

/* -------------------------------------------------------------------------- */
/* C. 后台主流程                                                               */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* C 段公共前置：剥注释 + 按花括号配平切出真实函数体                              */
/* -------------------------------------------------------------------------- */

/**
 * `apps/web/src/lib/admin/actions.ts` 里 `await requireAdmin()` 的**真实**调用次数。
 *
 * 2026-10-24 实测（`pwsh` + 剥注释后正则计数）= **5**：
 * `saveEntryAction` / `createEntryAction` / `transitionStatus` /
 * `bulkArchiveAction` / `restoreRevisionAction` 各一条。
 *
 * 为什么要有这个数字：只靠「每个函数体内都能匹配到 requireAdmin」有个集体失明
 * 的盲区 —— 一旦切片逻辑变宽（回到「切到下一个 export 为止」），每个函数都会
 * 「看见」邻居的鉴权，于是全部变绿。总数是切片好坏都绕不过去的地面真值。
 *
 * 增删鉴权必须显式改这个常量，这是刻意的摩擦。
 */
const EXPECTED_REQUIRE_ADMIN_COUNT = 5;

/*
  ══ 为什么原来那版切片是错的（P6 审计用变异测试证明，不是推测）════════════

  第一版用「下一个 `export async function` 的位置」当切片的右边界：

      const to = i + 1 < starts.length ? starts[i + 1].index : source.length;

  `actions.ts` 里有个**非导出**的内部实现 `async function transitionStatus(`
  （约 `:503`）。它不带 `export`，所以不会被当成切片边界，于是它整段被吞进
  上一个导出函数 `saveEntryAction` 的地盘里。后果实测：

      saveEntryAction 的切片长度 9807 字符，跨 :358 → :680
      → 切片内出现 **两条** `await requireAdmin()`（:359 自己的、:507 的）
      → 切片内出现 **两处** `.where(and(eq(entries.id...`（:420 与 :615）

  变异测试把 :359 那行注释掉以后，切片里还剩 :507 那一条，
  `/await requireAdmin\(\)/` 照样匹配 → **18/18 全绿，断言完全空转**。
  乐观锁同理：改坏 :420，`:615` 还满足那条正则。

  所以这里改成两道处理：**剥注释**（防注释里的字样冒充真代码）+ **花括号配平**
  （防相邻函数越界）。切片精度从「到下一个 export 为止」变成「正好这个函数体」。
*/

/**
 * 把 TS 源码里的注释替换成**等长空白**（保留换行，行号不漂），返回剥离后的文本。
 *
 * 为什么必须剥注释：这是 P6 审计里 4 条空转断言中 2 条（A2 / A3）的直接成因 ——
 * 「全文件 raw 文本扫描」时，`mergeTagsByUrl` / `canonical` 这两个词出现在
 * import 语句或解释性注释里就算命中。把真代码搬进注释，测试照样绿。
 *
 * 为什么等长替换而不是删掉：所有断言失败时要报 `文件:行号`，直接删注释会让
 * 后续行号全部错位。
 *
 * 覆盖三种形态（与 `a11y-audit.test.ts:181` 的 `stripComments()` 是同一套实现，
 * 这里刻意照抄而不是另发明一套 —— 同一个仓库里同一件事只该有一种做法）：
 *   · `{/* ... *\/}`  JSX 表达式容器里的注释
 *   · `/* ... *\/`    块注释
 *   · `// ...`         行注释
 *
 * 已知局限（写在这里防止后人误以为它很聪明）：正则剥注释对**字符串字面量里
 * 出现的 `//` 或 `/*`** 会误判。行注释那条正则用 `[^:\\]` 挡住了
 * `https://` 这类协议写法（本仓库源码里的 URL 字面量全是 `https://`），
 * 所以实际够用；真要绝对正确需上真正的词法扫描。
 */
function stripComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (whole, lead: string) => lead + blank(whole.slice(lead.length)));
}

/** 从 `braceStart` 处的 `{` 起做花括号配平，返回含首尾括号的整段。 */
function braceBlock(source: string, braceStart: number): string | null {
  let depth = 0;

  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, i + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}

/**
 * 从 `startIndex` 起，先配平参数列表的 `(...)`，再返回紧随其后的 `{...}` 函数体。
 *
 * ══ 为什么不能直接 `indexOf("{", startIndex)`（这条是自己踩出来的）══════
 * `generateMetadata({ params }: TagPageProps)` 的参数里就有解构花括号 `{ params }`。
 * 朴素实现会从这个 `{` 开始配平，`}` 立刻在 `{ params }` 处归零，于是「函数体」
 * 变成 7 个字符的 `{ params }` —— 里面当然没有 `alternates`，**假红**。
 * 所以必须先跳过参数列表：( → 配平到 ) → 再找 `{`。
 *
 * 已知局限：返回值类型注解里若出现花括号（`Promise<{ ok: boolean }>`），
 * 会在 `)` 之后先撞上那个 `{`。本仓库被扫的函数返回类型都是 `Promise<Metadata>`
 * / `Promise<ActionResult>` 这类无花括号的命名类型（已实测），所以够用。
 */
function bodyBlockAfter(source: string, startIndex: number): string | null {
  const parenStart = source.indexOf("(", startIndex);
  if (parenStart < 0) return null;

  let depth = 0;
  let parenEnd = -1;

  for (let i = parenStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        parenEnd = i;
        break;
      }
    }
  }

  if (parenEnd < 0) return null;

  const braceStart = source.indexOf("{", parenEnd);
  if (braceStart < 0) return null;

  return braceBlock(source, braceStart);
}

/**
 * 取出指定函数**真实**的函数体（`{ ... }`，含首尾括号），取不到返回 null。
 *
 * `export` 是可选的：`transitionStatus` 是内部实现（不导出），但它的函数体是
 * 「四个薄包装的鉴权到底在不在」的唯一证据，必须能取到。
 *
 * **调用方必须先 `stripComments()`**：注释里的花括号会把配平带偏，
 * 注释里的 `requireAdmin()` 字样也会冒充真代码。
 */
function extractFunctionBody(source: string, name: string): string | null {
  const head = new RegExp(`(?:export\\s+)?async\\s+function\\s+${name}\\s*\\(`).exec(source);
  if (head === null) return null;

  return bodyBlockAfter(source, head.index);
}

/**
 * 把 `actions.ts` 切成「导出函数名 → 真实函数体」的映射。
 *
 * 函数名仍用 `export async function` 枚举（只有导出函数才是 Server Action 入口），
 * 但**切片的右边界不再依赖下一个 export 的位置**，而是逐个做花括号配平。
 */
function splitExportedFunctions(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const header = /export\s+async\s+function\s+(\w+)\s*\(/g;

  let match = header.exec(source);
  while (match !== null) {
    const body = extractFunctionBody(source, match[1]);
    if (body !== null) result.set(match[1], body);
    match = header.exec(source);
  }

  return result;
}

test("P6-C8 每个 Server Action 都在函数体内做了 requireAdmin（准切片 + 总数对账）", () => {
  const actionsSource = readFileSync(
    path.join(SRC_ROOT, "lib/admin/actions.ts"),
    "utf8",
  );
  /*
    必须剥注释后再切：`actions.ts` 顶部的设计说明里就写着 `requireAdmin()`
    这些字样（第 36-54 行）。不剥的话，「注释里写过」会被当成「代码里有」——
    这正是审计报告里 A2/A3 两条空转的成因，不能在这里重犯。

    `stripComments()` 是**等长**替换（注释字符换成空格、保留换行），
    所以下面所有用 charIndex 做的切片、以及失败时报的行号都不会漂。
  */
  const actionsCode = stripComments(actionsSource);
  const functions = splitExportedFunctions(actionsCode);

  assert.ok(functions.size >= 9, `actions.ts 里的导出函数少于预期，实际 ${functions.size}`);

  /*
    ── 自检：这套切片本身不能是空转的 ────────────────────────────────────
    第一版切片（「切到下一个 export 为止」）会把内部函数 `transitionStatus`
    整段吞进 `saveEntryAction`。这里直接把那个错误形态钉死：
    saveEntryAction 的真实函数体里**不许**出现 `transitionStatus` 这个词，
    也不许出现第二条 `await requireAdmin()`。这两条一旦回退，立刻变红。
  */
  const saveBodyShallow = functions.get("saveEntryAction");
  assert.ok(saveBodyShallow, "找不到 saveEntryAction 的函数体");
  assert.ok(
    !saveBodyShallow.includes("transitionStatus"),
    "saveEntryAction 的切片跨进了 transitionStatus —— 花括号配平失效了，" +
      "这会让 C8/C10 重新退化成空转断言",
  );
  assert.equal(
    (saveBodyShallow.match(/await requireAdmin\(\)/g) ?? []).length,
    1,
    "saveEntryAction 的函数体里应当恰好有 1 条 await requireAdmin()。" +
      "多于 1 条说明切片越界（把相邻函数的鉴权也算进来了）",
  );

  /*
    方案 §8.4 的硬要求：**不能只靠 proxy matcher 拦**。
    Next 文档明确写着「Server Functions 不是独立路由，proxy matcher 排除的
    路径上的 Server Function 调用同样不会被拦」，所以每个 action 内部必须
    自己再校验一次。

    两个例外，都写在 allowlist 里并附理由：
    - `transitionStatus` 不是导出函数（是内部公共实现），由四个薄包装调用；
    - `adminSignOutAction` 是**登出**，此时用户可能已经掉线，要求它先校验
      管理员会让人「掉线后连登出都点不了」，只能等 cookie 过期。它的安全性
      由「只能操作自己的 session」保证。
  */
  const allowlist = new Map<string, string>([
    [
      "adminSignOutAction",
      "登出不能要求先通过管理员校验：掉线用户必须能主动清掉自己的会话，" +
        "否则只能等 cookie 过期。它只操作当前请求自己的 session，无越权面。",
    ],
  ]);

  /*
    transitionStatus 的真实函数体 —— 同样走准切片，不再用
    `actionsSource.slice(indexOf("async function transitionStatus"))`。
    那条切到文件末尾为止，等于「后面所有函数都算它的」，又是一次空转隐患。
  */
  const transitionBody = extractFunctionBody(actionsCode, "transitionStatus");
  assert.ok(transitionBody, "找不到 transitionStatus 的函数体");

  const missing: string[] = [];

  for (const [name, body] of functions) {
    if (allowlist.has(name)) continue;
    // 薄包装会转调 transitionStatus()，鉴权在那里
    const delegates = /return\s+transitionStatus\(/.test(body);
    if (delegates) {
      if (/const admin = await requireAdmin\(\);/.test(transitionBody)) continue;
      missing.push(`${name}（转调 transitionStatus，但 transitionStatus 里没有 requireAdmin）`);
      continue;
    }
    if (!/await requireAdmin\(\)/.test(body)) missing.push(name);
  }

  assert.deepEqual(
    missing,
    [],
    "以下 Server Action 没有在函数体内调用 requireAdmin()。" +
      "方案 §8.4 要求每个写操作独立校验 —— 只靠 proxy 是不够的，" +
      "因为 proxy matcher 排除了 api/ 路径，Server Function 的 POST 会绕过它",
  );

  /*
    ── (b) 总数对账：防「切片又变宽松了」这种集体性失明 ──────────────────
    单看「每个函数都有 requireAdmin」有个盲区：如果切片逻辑悄悄变宽
    （比如又退回到位置切片），每个函数都会「看见」邻居的鉴权，于是集体变绿。
    总数是切片好坏都绕不过去的硬指标：整个文件里 `await requireAdmin()`
    的**真实调用次数**是 5（2026-10-24 用 `pwsh` 正则实测，剥注释后计数）。

    这 5 条分别是：saveEntryAction / createEntryAction / transitionStatus
    / bulkArchiveAction / restoreRevisionAction。

    增删任何一处鉴权都必须显式改这个数字 —— 这是刻意的：鉴权是安全边界，
    改动它就该被一个失败测试拦住，哪怕只是「多加了看起来更安全的一层」。
  */
  const requireAdminCount = (actionsCode.match(/await requireAdmin\(\)/g) ?? []).length;
  assert.equal(
    requireAdminCount,
    EXPECTED_REQUIRE_ADMIN_COUNT,
    `actions.ts 里 \`await requireAdmin()\` 的实际调用次数变了（期望 ${EXPECTED_REQUIRE_ADMIN_COUNT}，实际 ${requireAdminCount}）。` +
      "如果这是有意增删鉴权，请同步更新 EXPECTED_REQUIRE_ADMIN_COUNT；" +
      "如果不是，说明有鉴权被删掉了 —— 这正是 C8 要拦的事",
  );
});

test("P6-C9 每个写操作都写了审计日志", () => {
  const actionsSource = readFileSync(
    path.join(SRC_ROOT, "lib/admin/actions.ts"),
    "utf8",
  );

  // 写操作 = 会改 entries / entry_revisions / tags / entry_tags 的 action
  const writeActions = [
    "createEntryAction",
    "saveEntryAction",
    "bulkArchiveAction",
    "restoreRevisionAction",
  ];

  const functions = splitExportedFunctions(actionsSource);

  for (const name of writeActions) {
    const body = functions.get(name);
    assert.ok(body, `找不到 action：${name}`);
    assert.match(
      body,
      /insert\(auditLogs\)/,
      `${name} 没有写审计日志。方案 §13.5 要求「登录、发布、删除、恢复写审计」`,
    );
  }

  // 状态流转（发布/定时/归档/撤下）四个薄包装共用 transitionStatus，审计在那里
  const transitionIndex = actionsSource.indexOf("async function transitionStatus");
  assert.ok(transitionIndex > 0, "找不到 transitionStatus");
  const transitionBody = actionsSource.slice(transitionIndex);
  assert.match(
    transitionBody,
    /insert\(auditLogs\)/,
    "transitionStatus 必须写审计（发布/定时/归档/撤下四个动作共用它）",
  );

  // 审计的 action 取值必须来自显式常量，不能是随手拼的字符串
  assert.match(
    actionsSource,
    /AUDIT_ACTIONS|const\s+ACTION_\w+\s*=|action:\s*"(entry|auth)\./,
    "审计的 action 字段必须来自显式常量或固定字面量前缀（entry.* / auth.*）",
  );
});

test("P6-C10 保存走乐观锁：where 必须同时锁 id 与 version（整串精确包含 + 数量对账）", () => {
  const actionsSource = readFileSync(
    path.join(SRC_ROOT, "lib/admin/actions.ts"),
    "utf8",
  );
  /*
    同 C8：剥注释后再切片。乐观锁那条 `.where(...)` 的形态在注释里也被
    讨论过（文件头设计说明里就贴着这段代码），不剥会把注释当代码。
  */
  const actionsCode = stripComments(actionsSource);
  const saveBody = extractFunctionBody(actionsCode, "saveEntryAction");

  assert.ok(saveBody, "找不到 saveEntryAction 的函数体");

  /*
    ── 为什么改成「整串精确包含」而不是正则 ──────────────────────────────
    原断言是 `/\.where\(\s*and\(\s*eq\(entries\.id,\s*entryId\),\s*eq\(entries\.version,/`。
    正则的空白容错 `\s*` + 只匹配到 `eq(entries.version,` 就收尾，意味着
    「后半句写成什么都行」，而且只要切片里**任何一处**有这形态就过。

    改成精确整串之后，变异测试的判定才真的落在「这一行有没有被改坏」上：
    把 `eq(entries.version, base.expectedVersion)` 删掉、或把 two-condition
    的 and() 拆成只锁 id，字符串立刻对不上。

    注意：这里必须用**同一份 `stripComments()` 结果**切片。若用原始
    actionsSource 切片、再比对带注释的文本，注释里的空白差异会让
    includes() 假红。
  */
  const LOCK_WHERE =
    ".where(and(eq(entries.id, entryId), eq(entries.version, base.expectedVersion)))";

  assert.ok(
    saveBody.includes(LOCK_WHERE),
    "saveEntryAction 的 UPDATE 必须在 WHERE 里**同时**锁 id 与 version（乐观锁）。\n" +
      `期望精确出现：${LOCK_WHERE}\n` +
      "只在应用层比较 version 有 TOCTOU 窗口：读与写之间别人可能已经改了这条记录",
  );

  /*
    ── 锚定到 UPDATE 那条链，而不是「函数里随便有没有」────────────────────
    `saveEntryAction` 里**合法地**有两处 `.where(`：
      ①:383 预读用的 `tx.select()...where(eq(entries.id, entryId))` —— 只按 id，
        它的作用是「读出现有 version，以便区分 404 与版本冲突」；
      ②:420 UPDATE 上的 `.where(and(id, version))` —— 这才是乐观锁。

    所以「数量 == 1」是错的断言（第一版就是这么写的，被自己的测试当场打脸）。
    真正要守的是「**UPDATE 那条链**上的 where 必须是双条件」：把锁从 UPDATE
    挪到预读 select、UPDATE 只按 id 写，那是标准的 TOCTOU 退化，而
    「函数里某处有 and(id,version)」这种全局匹配抓不住它。
  */
  const updateIndex = saveBody.indexOf(".update(entries)");
  assert.ok(updateIndex > 0, "saveEntryAction 里找不到 `.update(entries)`，切片或实现变了");

  const updateChain = saveBody.slice(updateIndex, saveBody.indexOf(";", updateIndex));
  assert.ok(
    updateChain.includes(LOCK_WHERE),
    "saveEntryAction 的 **UPDATE 链**必须在 WHERE 里同时锁 id 与 version（乐观锁）。\n" +
      `期望在 \`.update(entries)\` 之后精确出现：${LOCK_WHERE}\n` +
      "只在应用层比较 version 有 TOCTOU 窗口：读与写之间别人可能已经改了这条记录",
  );

  /*
    反向守卫：UPDATE 之前的预读**不许**出现 `where(and(`。
    一旦有人把锁写到预读上（读的时候就 and(id,version)）、UPDATE 退回只按 id，
    上面那条 updateChain 断言会红 —— 这条再把「反过来也错」的形态堵住，
    免得未来的改动为了绕开断言去动预读。
  */
  assert.ok(
    !/\.where\(and\(/.test(saveBody.slice(0, updateIndex)),
    "乐观锁不该写在 UPDATE 之前的预读 select 上。预读的作用是读出现有 version" +
      "以区分「不存在」和「被改过」，锁必须在 UPDATE 的 WHERE 里由数据库原子判断",
  );

  /*
    整条 UPDATE 链上只能有一处 `.where(`。
    多出来的那处意味着这条链被拆成了「先 where(id) 更新、再 where(...) 补一刀」，
    或者链上被塞了第二个带条件的语句 —— 两种都会让「一次原子 UPDATE」变成多次写。
  */
  assert.equal(
    (updateChain.match(/\.where\(/g) ?? []).length,
    1,
    "saveEntryAction 的 UPDATE 链上应当恰好 1 处 `.where(`（即那句乐观锁）",
  );

  // 冲突时不能静默成功，必须返回冲突信号
  assert.match(
    saveBody,
    /conflict/,
    "saveEntryAction 必须显式处理版本冲突（返回 conflict 而不是静默覆盖）",
  );

  /*
    一致性守卫：切片拿到的必须是 saveEntryAction 自己的函数体，而不是
    「到下一个 export 为止」的大杂烩。用两条互斥证据钉住：
    ①它必须含自己的业务语句 `db.transaction`；
    ②它必须**不含** transitionStatus（那是相邻的内部函数）。
    第二条正是原来位置切片失效的直接原因，必须显式守住。
  */
  assert.ok(saveBody.includes("db.transaction"), "saveEntryAction 的切片里没有 db.transaction，切片取错了函数");
  assert.ok(
    !saveBody.includes("transitionStatus"),
    "saveEntryAction 的切片跨进了 transitionStatus —— 花括号配平失效，" +
      "C10 的 where 数量断言会因此变成空转",
  );
});

/* -------------------------------------------------------------------------- */
/* D. 视觉 / 移动端 / 暗色                                                     */
/* -------------------------------------------------------------------------- */

test("P6-D11 响应式只用 Tailwind 默认断点，不出现 min-[...] 魔法值", () => {
  const offenders: string[] = [];

  for (const file of ALL_TSX) {
    const source = readFileSync(file, "utf8");
    const matches = source.match(/min-\[[^\]]*\]/g);
    if (matches) {
      for (const match of matches) {
        offenders.push(`${relativeToSrc(file)}: ${match}`);
      }
    }
  }

  /*
    自定义断点（`min-[900px]:`）看起来灵活，实际有两个问题：
    ①它与设计令牌体系脱节 —— 全站断点由 Tailwind 的 sm/md/lg/xl 定义，
       突然出现一个 900px 会让「哪些尺寸算移动端」变成逐个组件猜；
    ②它不会被 `@theme` 覆盖，将来统一调断点时会漏掉。
    所以这里要求零出现。真要加，先在 tailwind 配置里加具名断点。
  */
  assert.deepEqual(offenders, [], "出现了自定义断点 min-[...]，请改用 Tailwind 默认断点");
});

test("P6-D12 暗色模式无 FOUC：themeInitScript 在 head 内、body 之前", () => {
  const layoutSource = readFileSync(path.join(APP_ROOT, "layout.tsx"), "utf8");

  const headOpen = layoutSource.indexOf("<head>");
  const headClose = layoutSource.indexOf("</head>");
  const bodyOpen = layoutSource.indexOf("<body");

  assert.ok(headOpen > 0, "layout.tsx 必须有显式 <head>");
  assert.ok(headClose > headOpen, "layout.tsx 的 </head> 必须在 <head> 之后");
  assert.ok(bodyOpen > headClose, "layout.tsx 的 <body> 必须在 </head> 之后");

  const scriptIndex = layoutSource.indexOf("themeInitScript");
  assert.ok(scriptIndex > 0, "layout.tsx 必须使用 themeInitScript");

  /*
    关键：脚本必须**在 <head> 里被引用**（不是只声明）。
    `const themeInitScript = ...` 的声明在组件外，真正注入是
    `<script dangerouslySetInnerHTML={{ __html: themeInitScript }} />`。
    如果这个注入跑到了 <body> 里，浏览器会先绘制一帧浅色再切深色 = FOUC。
  */
  const injectionMatch = /<script[^>]*dangerouslySetInnerHTML=\{\{\s*__html:\s*themeInitScript/.exec(
    layoutSource,
  );
  assert.ok(injectionMatch, "layout.tsx 必须把 themeInitScript 注入为内联 <script>");

  const injectionIndex = injectionMatch.index;
  assert.ok(
    injectionIndex > headOpen && injectionIndex < headClose,
    "themeInitScript 的内联 <script> 必须落在 <head> 内。" +
      "放到 body 里会让暗色模式用户先看到一帧白底（FOUC）",
  );

  // 内联脚本会改变 <html> 的 class，与水合时的服务端输出不一致，
  // 必须靠 suppressHydrationWarning 压掉这条警告。
  assert.match(
    layoutSource,
    /<html[^>]*suppressHydrationWarning/,
    "<html> 必须带 suppressHydrationWarning —— themeInitScript 会改 class，" +
      "否则 React 会在控制台刷水合警告",
  );

  assert.match(layoutSource, /<html[^>]*lang="zh-CN"/, "<html> 必须有 lang");
});

test("P6-D12b 跳转链接指向真实存在的 main 锚点", () => {
  const rootLayout = readFileSync(path.join(APP_ROOT, "layout.tsx"), "utf8");
  const siteLayout = readFileSync(path.join(APP_ROOT, "(site)/layout.tsx"), "utf8");

  const skipLink = /href="#([\w-]+)"/.exec(rootLayout);
  assert.ok(skipLink, "根布局必须有「跳到主要内容」的跳转链接");

  const targetId = skipLink[1];
  assert.match(
    siteLayout,
    new RegExp(`id="${targetId}"`),
    `跳转链接指向 #${targetId}，但 (site)/layout.tsx 里没有 id="${targetId}"。` +
      "锚点不存在时键盘用户按下 Tab 会跳到页面顶部，等于没有跳转链接",
  );
});

/* -------------------------------------------------------------------------- */
/* E. 追加：真跑映射与接口对齐（P6 复核，analyst-2 补）                          */
/* -------------------------------------------------------------------------- */

/*
  上面 A~D 段的 P6-B7 只断言了「db/import.ts 的源码里确实从文件名派生 slug」，
  是**结构断言**。结构对了不代表 `mapEntry` 真跑起来也对 —— 比如 schema 改了、
  cover 解析坏了、projects.article 的引用检查炸了，源码正则全都看不出来。

  所以这一段做两件事：
  1. 用真实的 `db/mapping.ts` 把 10 个真实 md 文件**真跑一遍**；
  2. 把「接口加了方法但转发层忘了加」这类沉默失效变成本测试能报出来的失败。

  注意：`db/mapping.ts` 依赖 `@loxander/content-core`，后者的内部 import 是
  无扩展名的（`from '../primitives'`），Node 的 ESM 解析器不能直接解析。
  `db/mapping.test.ts` 用 `registerHooks` 补 `.ts` 后缀解决，这里照做 ——
  钩子必须在 `import('db/mapping.ts')` **之前**注册，所以用动态 import。
*/

/** 上溯到仓库根下的 `db/mapping.ts` 绝对路径。 */
const MAPPING_PATH = path.join(REPO_ROOT, "db/mapping.ts");

/** 注册 `.ts` 后缀补全钩子，返回可直接 import 的 mapping 模块。 */
async function importMapping(): Promise<{
  mapEntry: (
    kind: string,
    slug: string,
    raw: string,
    ctx: {
      publicDir: string;
      knownBlogSlugs?: readonly string[];
      now?: () => Date;
    },
  ) => {
    ok: boolean;
    row?: {
      slug: string;
      title: string;
      summary: string;
      body_md: string;
      publish_status: string;
      featured: boolean;
      sort_order: number;
      published_at: Date | null;
      display_date: string | null;
      data: Record<string, unknown>;
      version: number;
    };
    tags?: string[];
    body?: string;
    warnings?: { level: string; field?: string; message: string }[];
    issues?: { level: string; field?: string; message: string }[];
  };
}> {
  const { registerHooks } = await import("node:module");

  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const isRelative =
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          specifier.startsWith("file:");
        if (!isRelative) throw error;
        const parent = context.parentURL
          ? fileURLToPath(context.parentURL)
          : process.cwd();
        const bare = specifier.startsWith("file:")
          ? fileURLToPath(specifier)
          : specifier;
        const target = path.resolve(path.dirname(parent), bare);
        for (const ext of [".ts", ".tsx"]) {
          if (existsSyncForHook(target + ext)) {
            return {
              url: pathToFileURL(target + ext).href,
              shortCircuit: true,
            };
          }
        }
        throw error;
      }
    },
  });

  return (await import(/* @vite-ignore */ pathToFileURL(MAPPING_PATH).href)) as never;
}

/** 单独的 existsSync 引用，避免与文件顶部的 import 名单冲突。 */
function existsSyncForHook(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

test("P6-B8 真实 md 文件经 mapEntry 映射后 slug 与文件名 stem 一致（真跑，不是读源码）", async () => {
  const mapping = await importMapping();

  const kinds = [
    { kind: "blog", dir: "blog" },
    { kind: "diary", dir: "diary" },
    { kind: "projects", dir: "projects" },
    { kind: "goals", dir: "goals" },
  ] as const;

  const publicDir = path.join(APP_WEB_ROOT, "public");
  const knownBlogSlugs = readdirSync(path.join(CONTENT_ROOT, "blog"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""));

  const problems: string[] = [];
  const perKind: Record<string, number> = {};
  let total = 0;

  for (const { kind, dir } of kinds) {
    const dirPath = path.join(CONTENT_ROOT, dir);
    const files = readdirSync(dirPath).filter((name) => name.endsWith(".md"));
    perKind[kind] = files.length;

    for (const file of files) {
      const slug = file.replace(/\.md$/, "");
      const raw = readFileSync(path.join(dirPath, file), "utf8");

      const result = mapping.mapEntry(kind, slug, raw, {
        publicDir,
        knownBlogSlugs,
        // 固定时间戳，让 projects / goals 的 published_at 不随跑测试的时刻漂移。
        now: () => new Date("2026-01-01T00:00:00Z"),
      });

      if (!result.ok) {
        const issues = (result.issues ?? [])
          .map((issue) => `[${issue.level}] ${issue.field ?? "-"}: ${issue.message}`)
          .join(" | ");
        problems.push(`${kind}/${file} 映射失败：${issues}`);
        continue;
      }

      /*
        这是本测试的核心：`mapEntry` 的 slug 是**入参**，只要调用方传对了，
        返回值里的 slug 必然等于入参 —— 所以真正被断言的是「传进去的 slug
        就是文件名 stem」这条链路没有在中间被改写。
      */
      if (result.row?.slug !== slug) {
        problems.push(
          `${kind}/${file} 映射后 slug 变成 ${String(result.row?.slug)}，与文件名 stem ${slug} 不一致（URL 会变）`,
        );
      }

      // 一条 row 的必备列不能是 undefined：undefined 会在 drizzle insert 时静默落成 DEFAULT。
      for (const column of [
        "title",
        "summary",
        "body_md",
        "publish_status",
        "featured",
        "sort_order",
        "data",
        "version",
      ] as const) {
        if (result.row?.[column] === undefined) {
          problems.push(`${kind}/${file} 的 ${column} 是 undefined`);
        }
      }

      if (kind === "blog" || kind === "diary") {
        if (!(result.row?.publish_status === "published" || result.row?.publish_status === "draft")) {
          problems.push(`${kind}/${file} 的 publish_status 越界：${String(result.row?.publish_status)}`);
        }
      }

      total += 1;
    }
  }

  assert.deepEqual(problems, [], "真实内容经 mapEntry 映射时出现问题");

  // 方案 §11 的验收基线：10 篇内容（4 blog / 1 diary / 3 projects / 2 goals）。
  // 这个数字写死是有意的 —— 内容增删应当是一次显式决定。
  assert.deepEqual(perKind, { blog: 4, diary: 1, projects: 3, goals: 2 }, "真实内容数量与基线不符");
  assert.equal(total, 10, `期望映射 10 篇内容，实际 ${total}`);
});

test("P6-B9 真实内容的标签可经 tagHref/decodeTagParam 无损往返（URL 不会丢字）", async () => {
  const mapping = await importMapping();
  const tagUrl = await import("../tag-url");

  const publicDir = path.join(APP_WEB_ROOT, "public");
  const knownBlogSlugs = readdirSync(path.join(CONTENT_ROOT, "blog"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""));

  const problems: string[] = [];
  const seen: string[] = [];
  /** 按 kind 收集标签，用于分别断言「blog 必须有标签」这类事实。 */
  const tagsByKind: Record<string, string[]> = { blog: [], diary: [] };
  /** 按文件收集标签，用于断言「同一篇里没有大小写重复的标签」。 */
  const tagsPerFile: Record<string, string[]> = {};

  for (const kind of ["blog", "diary"] as const) {
    const dirPath = path.join(CONTENT_ROOT, kind);

    for (const file of readdirSync(dirPath).filter((name) => name.endsWith(".md"))) {
      const slug = file.replace(/\.md$/, "");
      const result = mapping.mapEntry(kind, slug, readFileSync(path.join(dirPath, file), "utf8"), {
        publicDir,
        knownBlogSlugs,
        now: () => new Date("2026-01-01T00:00:00Z"),
      });

      assert.ok(result.ok, `${kind}/${file} 映射失败，无法验证标签往返`);

      tagsPerFile[`${kind}/${file}`] = result.tags ?? [];

      for (const tag of result.tags ?? []) {
        tagsByKind[kind].push(tag);
        seen.push(tag);

        const href = tagUrl.tagHref(tag);
        const expectedHref = `${tagUrl.TAGS_PATH}/${encodeURIComponent(tagUrl.tagSlugOfName(tag))}`;
        if (href !== expectedHref) {
          problems.push(`${kind}/${file} 标签「${tag}」的 href 是 ${href}，期望 ${expectedHref}`);
        }

        // URL 段 → 解码 → 与原标签的小写形式比较，必须能对上（否则点标签会 404）。
        const segment = href.slice(tagUrl.TAGS_PATH.length + 1);
        const decoded = tagUrl.decodeTagParam(segment);
        if (decoded !== tagUrl.tagSlugOfName(tag)) {
          problems.push(
            `${kind}/${file} 标签「${tag}」往返失败：解码得到「${decoded}」，期望「${tagUrl.tagSlugOfName(tag)}」`,
          );
        }

        // 归一化后的形式必须能被 tagMatches 认出原标签（大小写不敏感匹配）。
        if (!tagUrl.tagMatches(tag, segment)) {
          problems.push(`${kind}/${file} 标签「${tag}」经 tagMatches 匹配失败`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], "标签 URL 往返存在问题");

  /*
    关于「blog 与 diary 的 tags 都非空」这条期望：
    真实数据里 **只有 blog 的 4 篇有 tags**；`diary/week01.md` 的 frontmatter
    根本没有 `tags` 键（content-core 的 `diarySchema.tags = zStringSet` 会把它
    补成 `[]`）。所以这里不能一刀切断言「非空」，否则测试会与真实数据打架。
    正确的断言是：blog 必须有标签（标签是 blog 的核心分类维度），diary 允许为空。
  */
  assert.ok(tagsByKind.blog.length > 0, "blog 内容必须带标签");
  assert.equal(
    tagsByKind.diary.length,
    0,
    "diary 当前真实数据没有 tags（diary/week01.md 无该键）；" +
      "若未来给日记加了标签，请同步更新这条断言与报告里的说明",
  );

  // 同一篇内容内部的标签不该有大小写重复（"RAG" 与 "rag" 会产出同一个 URL）。
  //
  // 注意这是**按文件**判的：跨文件重复是正常的（"RAG" 同时属于
  // langgraph-rag-workflow 与 rag-chunking-strategies 两篇文章，这正是标签的意义）。
  // 会出问题的只有「同一篇里写了 RAG 又写了 rag」——那会让 /tags/rag 下的
  // 计数虚高、entry_tags 里出现两条同 URL 的记录。
  const perFileDuplicates: string[] = [];
  for (const [label, tags] of Object.entries(tagsPerFile)) {
    const normalized = tags.map((tag) => tagUrl.tagSlugOfName(tag));
    const duplicates = normalized.filter((value, index) => normalized.indexOf(value) !== index);
    for (const duplicate of new Set(duplicates)) {
      perFileDuplicates.push(`${label}: 「${duplicate}」在本文档内重复出现（大小写不同但同 URL）`);
    }
  }
  assert.deepEqual(
    perFileDuplicates,
    [],
    "同一篇内容里出现了归一化后重复的标签，它们会指向同一个 /tags/[tag] URL",
  );

  // 跨文件的标签集合去重后，每个归一化 URL 只能对应一个展示名 ——
  // 否则 /tags 页会出现两条指向同一 URL 的条目（P5 用 mergeTagsByUrl 合并，
  // 但合并的前提正是「同一个 URL 的展示名要一致」，这里把它固化为数据层约束）。
  const displayByUrl = new Map<string, Set<string>>();
  for (const tag of seen) {
    const url = tagUrl.tagSlugOfName(tag);
    const bucket = displayByUrl.get(url) ?? new Set<string>();
    bucket.add(tag);
    displayByUrl.set(url, bucket);
  }
  const conflicting = Array.from(displayByUrl.entries())
    .filter(([, names]) => names.size > 1)
    .map(([url, names]) => `${url} ← ${Array.from(names).join(" / ")}`);
  assert.deepEqual(
    conflicting,
    [],
    "同一个标签 URL 对应了多个不同写法的展示名（如 RAG 与 Rag 并存）",
  );
});

test("P6-A5 三个 [slug] 详情页的 openGraph.url 都由 siteConfig.url 拼出（换域名不会漏）", () => {
  const detailPages = [
    { file: "(site)/blog/[slug]/page.tsx", segment: "blog" },
    { file: "(site)/diary/[slug]/page.tsx", segment: "diary" },
    { file: "(site)/projects/[slug]/page.tsx", segment: "projects" },
  ] as const;

  const problems: string[] = [];

  for (const { file, segment } of detailPages) {
    const source = readFileSync(path.join(APP_ROOT, file), "utf8");

    if (!/import\s*\{[^}]*siteConfig[^}]*\}\s*from\s*"@\/lib\/site"/.test(source)) {
      problems.push(`${file} 没有从 @/lib/site 导入 siteConfig`);
    }

    /*
      关键点：openGraph.url 必须是**绝对地址**（Open Graph 协议要求），
      且必须由 siteConfig.url 拼，不能写死 `https://loxander.is-a.dev` ——
      写死的话换个域名部署，所有分享卡片的 url 还指着旧域名。
    */
    if (!new RegExp(`url:\\s*\`\\$\\{siteConfig\\.url\\}/${segment}/`).test(source)) {
      problems.push(`${file} 的 openGraph.url 没有用 \`\${siteConfig.url}/${segment}/...\` 拼`);
    }

    if (!/alternates:\s*\{\s*canonical:/.test(source)) {
      problems.push(`${file} 没有 alternates.canonical`);
    }
  }

  assert.deepEqual(problems, [], "详情页的 Open Graph / canonical 结构不一致");

  /*
    /tags/[tag] 是**唯一**没有 openGraph 的公开动态页。
    这不是漏写：标签页的内容就是「某个标签下的文章列表」，分享卡片没有独立语义，
    且 canonical 已由 `tagHref(known.tag)` 给出（与页面正文同一个归一化函数）。
    这里把它固化成断言，避免将来有人「顺手补一个 openGraph」却不走 siteConfig.url。
  */
  const tagPage = readFileSync(path.join(APP_ROOT, "(site)/tags/[tag]/page.tsx"), "utf8");
  assert.match(
    tagPage,
    /canonical:\s*tagHref\(known\.tag\)/,
    "标签页的 canonical 必须调 tagHref()（与页面正文同一判据），不能手拼字符串",
  );
  assert.ok(
    !/openGraph:/.test(tagPage),
    "标签页当前不设 openGraph。若确要加，必须先确认 url 走 siteConfig.url 并同步更新本断言",
  );
});

test("P6-C11 @/lib/content 的导出面与 ContentSource 接口成员逐个对齐", async () => {
  const contentSourceSource = readFileSync(path.join(SRC_ROOT, "lib/content-source.ts"), "utf8");
  const contentSourceBarrel = readFileSync(path.join(SRC_ROOT, "lib/content.ts"), "utf8");
  const tagUrl = await import("../tag-url");

  /*
    这条断言防的是一类「沉默失效」：给 `ContentSource` 加了方法、两个实现也都写了，
    但忘了在 `@/lib/content` 里加转发函数。结果页面层根本调不到它，
    `tsc` 也不会报错（接口多一个方法不影响任何调用方），只有真跑才发现「怎么没生效」。
  */
  const interfaceMatch = /export interface ContentSource\s*\{([\s\S]*?)\n\}/.exec(
    contentSourceSource,
  );
  assert.ok(interfaceMatch, "找不到 ContentSource 接口定义，本测试需要同步更新");

  const members = Array.from(interfaceMatch[1].matchAll(/^\s{2}(\w+)\s*[(:]/gm))
    .map((match) => match[1])
    // `kind` 是只读属性不是可取数的方法，转发层没有对应函数是对的。
    .filter((name) => name !== "kind")
    .sort();

  const forwarded = Array.from(
    contentSourceBarrel.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g),
  )
    .map((match) => match[1])
    .sort();

  assert.ok(members.length >= 15, `ContentSource 成员少于预期，实际 ${members.length}`);
  assert.deepEqual(
    forwarded,
    members,
    "转发层与接口不对齐：在 ContentSource 加了方法但忘了在 @/lib/content 转发（或反过来）",
  );

  /*
    转发层不许有业务逻辑：每个函数体只能是 `return (await getContentSource()).xxx(...)`。

    这里按「函数起点 → 下一个函数起点」切片，而不是去匹配花括号 —— 因为
    `getAdjacentPosts` 的返回类型注解里就含 `{ prev: ...; next: ... }`，
    任何基于 `{` 的朴素正则都会被它带偏。切片之后检查三件事：
    ① 有唯一一条 `return (await getContentSource()).<同名方法>(`；
    ② 没有排序/过滤/映射/分支这类会造出「第三个实现」的语句；
    ③ 切片里不出现第二个 `return`（说明没有兜底分支）。
  */
  const chunks = new Map<string, string>();
  const starts = Array.from(
    contentSourceBarrel.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g),
  );
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index].index;
    const to = index + 1 < starts.length ? starts[index + 1].index : contentSourceBarrel.length;
    chunks.set(starts[index][1], contentSourceBarrel.slice(from, to));
  }

  const offenders: string[] = [];
  for (const [name, chunk] of chunks) {
    const returns = Array.from(chunk.matchAll(/\breturn\b/g)).length;
    if (!new RegExp(`return\\s+\\(await\\s+getContentSource\\(\\)\\)\\.${name}\\(`).test(chunk)) {
      offenders.push(`${name}: 没有转调 getContentSource().${name}()`);
      continue;
    }
    if (returns !== 1) {
      offenders.push(`${name}: 出现了 ${returns} 个 return（转发层不该有兜底分支）`);
    }
    const logic = [".sort(", ".filter(", ".map(", ".slice(", "if (", "for (", "while (", "throw ", "??"];
    const hit = logic.filter((token) => chunk.includes(token));
    if (hit.length > 0) {
      offenders.push(`${name}: 含有业务逻辑 ${hit.join(" ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "转发函数体内出现了业务逻辑。一旦这里排序/过滤，它就变成 markdown 与 db 之外的第三个实现",
  );

  // 顺带守住 tag-url 的入口常量没被改名（tickets 与页面都依赖它们）。
  assert.equal(tagUrl.TAGS_PATH, "/tags");
  assert.equal(tagUrl.SEARCH_PATH, "/search");
});
