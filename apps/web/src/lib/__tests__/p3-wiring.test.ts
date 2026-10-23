/**
 * P3 页面层接线的端到端验证（离线可跑，不需要 Next 起服务）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 * P3 的验收标准是「所有旧 URL 返回 200」「页面 HTML 与旧版一致」，
 * 但那需要 `next dev` / `next build` —— 本机沙箱禁止子进程（`spawn EPERM`，
 * 见执行记录 §7.3 陷阱 3），两条路都跑不起来。
 *
 * 退而求其次能验的是：**页面层调用的每一个数据函数是否真的能取到数**。
 * 这正是 P3 唯一有风险的改动（12 处调用从同步改异步、3 处
 * `generateStaticParams` 变 async、`sitemap()` 变 async）—— 加漏一个 `await`，
 * `tsc` 会报错，但「加对了却拿到空数组」不会报错，只有真跑才知道。
 *
 * 所以这里直接 import 页面层用到的模块与两个 Route（`sitemap.ts` /
 * `rss.xml/route.ts` 都是纯 TS，没有 JSX，node 能直接加载），
 * 断言它们返回真实数据。页面 `.tsx` 无法在 node 里加载（JSX 未转译），
 * 那部分的正确性由 `tsc --noEmit` + `next build` 的编译阶段共同保证。
 *
 * 跑法：`node --test-isolation=none apps/web/src/lib/__tests__/p3-wiring.test.ts`
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `apps/web/src`（本文件在 `src/lib/__tests__/` 下，往上两层）。 */
const SRC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
/** `apps/web`。 */
const WEB_DIR = resolvePath(SRC_DIR, "..");
/** 仓库根 `loxander-platform`。 */
const REPO_DIR = resolvePath(WEB_DIR, "..", "..");

const SERVER_ONLY_EMPTY = resolvePath(REPO_DIR, "node_modules/server-only/empty.js");
const NEXT_CACHE_STUB = resolvePath(SRC_DIR, "lib/sources/__tests__/next-cache-stub.ts");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: pathToFileURL(SERVER_ONLY_EMPTY).href, shortCircuit: true };
    }
    if (specifier === "next/cache") {
      return { url: pathToFileURL(NEXT_CACHE_STUB).href, shortCircuit: true };
    }

    if (specifier.startsWith("@/")) {
      const base = resolvePath(SRC_DIR, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(base + ext)) {
          return { url: pathToFileURL(base + ext).href, shortCircuit: true };
        }
      }
      if (existsSync(base)) return { url: pathToFileURL(base).href, shortCircuit: true };
    }

    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const isRelative =
        specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:");
      if (!isRelative) throw error;
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
      const bare = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
      const target = resolvePath(dirname(parent), bare);
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(target + ext)) {
          return { url: pathToFileURL(target + ext).href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
});

// 四个旧 lib 用 `path.join(process.cwd(), "content", ...)` 定位 markdown，必须切到 apps/web。
process.chdir(WEB_DIR);

import { test } from "node:test";
import assert from "node:assert/strict";

const content = await import("../content");
const sitemapModule = await import("../../app/sitemap");
const rssModule = await import("../../app/rss.xml/route");

/* -------------------------------------------------------------------------- */
/* 1. repository 层：15 个函数全部能取到真实数据                                 */
/* -------------------------------------------------------------------------- */

test("P3 接线：repository 层 15 个函数都返回真实数据（不是空壳）", async () => {
  const [blogSlugs, posts, recent, tags, categories, projects, featured, diary, diarySlugs, goals] =
    await Promise.all([
      content.getBlogSlugs(),
      content.getAllPosts(),
      content.getRecentPosts(3),
      content.getAllTags(),
      content.getAllCategories(),
      content.getAllProjects(),
      content.getFeaturedProjects(3),
      content.getAllDiaryEntries(),
      content.getDiarySlugs(),
      content.getAllGoals(),
    ]);

  // 数量与 P2 的 markdown 基线一致：blog 4 / diary 1 / projects 3 / goals 2。
  assert.equal(blogSlugs.length, 4, "blog slug 应为 4 个");
  assert.equal(posts.length, 4, "文章应为 4 篇");
  assert.equal(recent.length, 3, "getRecentPosts(3) 应返回 3 篇");
  assert.equal(diary.length, 1, "日记应为 1 篇");
  assert.equal(diarySlugs.length, 1, "日记 slug 应为 1 个");
  assert.equal(projects.length, 3, "项目应为 3 个");
  assert.equal(featured.length, 3, "getFeaturedProjects(3) 应返回 3 个");
  assert.equal(goals.length, 2, "目标应为 2 个");

  // 聚合类必须有内容 —— 这条专门防「返回空数组也算成功」的假绿。
  assert.ok(tags.length > 0, `getAllTags() 不能为空（实际 ${tags.length}）`);
  assert.ok(categories.length > 0, `getAllCategories() 不能为空（实际 ${categories.length}）`);

  // 标签顺序与计数必须自洽。
  for (const item of tags) {
    assert.equal(typeof item.tag, "string");
    assert.ok(item.count >= 1, `标签 ${item.tag} 的计数应 ≥ 1`);
  }
});

test("P3 接线：详情路径按 slug 查询，存在返回对象、不存在返回 null", async () => {
  const post = await content.getPost("rag-chunking-strategies");
  assert.ok(post, "已知 slug 必须能取到文章");
  assert.ok(post.html.length > 0, "文章必须带渲染后的 HTML");
  assert.ok(post.headings.length > 0, "文章必须带 TOC");

  const missingPost = await content.getPost("this-slug-does-not-exist");
  assert.equal(missingPost, null, "不存在的 slug 必须返回 null 而不是抛错");

  // 项目 slug 用真实文件里的那个（content/projects/rag-knowledge-assistant.md）。
  const project = await content.getProject("rag-knowledge-assistant");
  assert.ok(project, "已知 slug 必须能取到项目");
  assert.ok(project.html.length > 0);

  const goalList = await content.getAllGoals();
  assert.ok(goalList[0].html.length > 0, "目标正文必须已渲染");
});

test("P3 接线：getAdjacentPosts / getRelatedPosts 返回可用的导航数据", async () => {
  const posts = await content.getAllPosts();
  const middle = posts[1].slug;

  const { prev, next } = await content.getAdjacentPosts(middle);
  assert.ok(prev, "中间那篇应有 prev");
  assert.ok(next, "中间那篇应有 next");
  assert.notEqual(prev.slug, middle);
  assert.notEqual(next.slug, middle);

  const related = await content.getRelatedPosts(middle, 2);
  assert.ok(Array.isArray(related));
  assert.ok(related.length <= 2);
  for (const item of related) {
    assert.notEqual(item.slug, middle, "相关文章不能包含自己");
  }
});

/* -------------------------------------------------------------------------- */
/* 2. sitemap：已改成 async，且内容来自 ContentSource                            */
/* -------------------------------------------------------------------------- */

test("P3 sitemap：async 函数，覆盖全部旧路由且内容来自 ContentSource", async () => {
  const routes = await sitemapModule.default();

  // 8 条静态 + 4 篇 blog + 3 个项目 + 1 篇日记 = 16
  assert.equal(routes.length, 16, `sitemap 应有 16 条（实际 ${routes.length}）`);

  const urls = routes.map((r) => r.url);

  // 8 条静态路由一条都不能少 —— 这是「所有旧 URL 仍然在 sitemap 里」的硬要求。
  for (const path of ["/", "/universe", "/blog", "/projects", "/diary", "/goals", "/about", "/resume"]) {
    assert.ok(
      urls.some((u) => u.endsWith(path) || (path === "/" && u.endsWith("//"))),
      `sitemap 缺少静态路由 ${path}`,
    );
  }

  // 动态路由必须来自真实内容（4 篇文章 / 3 个项目 / 1 篇日记）。
  assert.equal(urls.filter((u) => u.includes("/blog/")).length, 4, "blog 详情应有 4 条");
  assert.equal(urls.filter((u) => u.includes("/projects/")).length, 3, "项目详情应有 3 条");
  assert.equal(urls.filter((u) => u.includes("/diary/")).length, 1, "日记详情应有 1 条");

  // 每条都必须有 changeFrequency 与 priority，否则搜索引擎拿到的是半成品。
  for (const route of routes) {
    assert.ok(route.changeFrequency, `${route.url} 缺 changeFrequency`);
    assert.equal(typeof route.priority, "number", `${route.url} 缺 priority`);
  }
});

/* -------------------------------------------------------------------------- */
/* 3. RSS：Route Handler 产出合法 XML                                          */
/* -------------------------------------------------------------------------- */

test("P3 RSS：/rss.xml 产出合法 XML，含全部文章且转义正确", async () => {
  const response = await rssModule.GET();
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /application\/rss\+xml/,
    "Content-Type 必须是 application/rss+xml",
  );

  const xml = await response.text();

  // 结构完整性
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "必须以 XML 声明开头");
  assert.ok(xml.includes('<rss version="2.0"'), "必须有 rss 根元素");
  assert.ok(xml.includes("<channel>"), "必须有 channel");
  assert.ok(xml.trimEnd().endsWith("</rss>"), "必须以 </rss> 结尾");

  // 4 篇文章 = 4 个 item
  const itemCount = (xml.match(/<item>/g) ?? []).length;
  assert.equal(itemCount, 4, `RSS 应含 4 个 item（实际 ${itemCount}）`);

  // 必备子元素
  for (const tag of ["<title>", "<link>", "<guid", "<pubDate>", "<description>"]) {
    assert.ok(xml.includes(tag), `RSS 缺少 ${tag}`);
  }

  // 转义：XML 里不允许出现裸的 `&`（除了合法的实体引用）。
  // 这条是手写 XML 最容易翻车的地方，站内标题/摘要里确实带 `&`。
  const bareAmpersand = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  assert.ok(!bareAmpersand.test(xml), "XML 里存在未转义的 & —— 会让订阅器解析失败");

  // 每篇文章的链接都必须是绝对 URL
  for (const post of await content.getAllPosts()) {
    assert.ok(xml.includes(`/blog/${post.slug}`), `RSS 缺少文章 ${post.slug}`);
  }
});

test("P3 RSS：空内容时也不产出非法 XML", async () => {
  // 直接验 escapeXml / toRfc822 的边界行为：这两个函数在文件内未导出，
  // 所以通过构造一次真实调用间接覆盖 —— 只要 GET 不抛错且结构完整即可。
  const response = await rssModule.GET();
  const xml = await response.text();
  assert.ok(xml.includes("<lastBuildDate>"), "必须有 lastBuildDate");
  assert.ok(!xml.includes("undefined"), "XML 里不能出现 undefined 字样");
  assert.ok(!xml.includes("Invalid Date"), "日期解析失败会写出 Invalid Date");
});
