/**
 * P5 接线验证（离线可跑，不需要 Next 起服务）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 * P5 新增了三块能力：服务端搜索（`lib/search.ts`）、标签页（`lib/tag-url.ts`
 * + `/tags`、`/tags/[tag]`）、以及两个内容源上的 `getPostsByTag` / `searchPosts`。
 *
 * 其中**只有纯函数与数据层能在 node 里直接跑**：页面 `.tsx` 含 JSX，node 不会
 * 转译（和 P3 的 `p3-wiring.test.ts` 是同一个限制）。所以这里验三件事：
 *
 * 1. 归一化规则（大小写 / 全角空格 / `+` 当空格 / 畸形编码）是不是真的统一；
 * 2. 搜索的匹配与排序是不是真的按设计走（AND 语义、权重、全序稳定）；
 * 3. 两个内容源的 `getPostsByTag` / `searchPosts` 是不是真的接上了真实数据 ——
 *    这一条最关键，因为「返回空数组」不会让 `tsc` 报错，只有真跑才看得见。
 *
 * 页面 `.tsx` 部分的正确性由 `tsc --noEmit` 与 `next build` 的编译阶段共同保证；
 * `generateStaticParams` / `generateMetadata` 的返回值形状由类型系统保证。
 *
 * 跑法：`node --test-isolation=none apps/web/src/lib/__tests__/p5-wiring.test.ts`
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
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

const search = await import("../search");
const tagUrl = await import("../tag-url");
const content = await import("../content");
const posts = await import("../posts");
const sitemapModule = await import("../../app/sitemap");

/* -------------------------------------------------------------------------- */
/* 1. tag-url：归一化规则只有一份                                              */
/* -------------------------------------------------------------------------- */

test("P5 标签 URL：tagSlugOfName 只做 trim + 小写，不做 slugify", () => {
  assert.equal(tagUrl.tagSlugOfName("RAG"), "rag");
  assert.equal(tagUrl.tagSlugOfName("  Vector DB  "), "vector db");
  // 中文原样保留 —— 任何 slugify 都会把中文吃掉或转成 `%E5%90%91...`，
  // 那样 URL 不可读、也不稳定（不同 slugify 库结果不同）。
  assert.equal(tagUrl.tagSlugOfName("向量检索"), "向量检索");
  // 空格保留（编码交给 encodeURIComponent，而不是替换成 `-`）——
  // 换成 `-` 会让「vector-db」这个真标签与「vector db」撞车。
  assert.equal(tagUrl.tagSlugOfName("vector db"), "vector db");
});

test("P5 标签 URL：tagHref 产出稳定可读路径，空标签兜底到 /tags", () => {
  assert.equal(tagUrl.tagHref("RAG"), "/tags/rag");
  assert.equal(tagUrl.tagHref("向量检索"), `/tags/${encodeURIComponent("向量检索")}`);
  // 空格编码成 %20 而不是 +，因为 decodeTagParam 两种都吃，但 %20 是 URL 标准。
  assert.equal(tagUrl.tagHref("vector db"), "/tags/vector%20db");
  // 空 / 全空白 → 总览页，绝不产出 `/tags/`（那会 404）。
  assert.equal(tagUrl.tagHref(""), "/tags");
  assert.equal(tagUrl.tagHref("   "), "/tags");
});

test("P5 标签 URL：decodeTagParam 对 + 与畸形编码都不抛错", () => {
  assert.equal(tagUrl.decodeTagParam("RAG"), "rag");
  // 查询串里空格会变成 `+`，路由段里不会，但两种都要能吃下。
  assert.equal(tagUrl.decodeTagParam("vector+db"), "vector db");
  assert.equal(tagUrl.decodeTagParam("vector%20db"), "vector db");
  // 畸形编码（%ZZ）不能抛 URIError 把整页打挂。
  assert.equal(tagUrl.decodeTagParam("%ZZ"), "%zz");
  assert.equal(tagUrl.decodeTagParam(""), "");
});

test("P5 标签 URL：tagMatches 大小写不敏感，且 + 与 %20 等价", () => {
  assert.equal(tagUrl.tagMatches("RAG", "rag"), true);
  assert.equal(tagUrl.tagMatches("rag", "RAG"), true);
  assert.equal(tagUrl.tagMatches("Vector DB", "vector+db"), true);
  assert.equal(tagUrl.tagMatches("Vector DB", "vector%20db"), true);
  assert.equal(tagUrl.tagMatches("RAG", "llm"), false);
  // 空路由段不匹配任何标签（否则 `/tags/` 会被当成「匹配全部」）。
  assert.equal(tagUrl.tagMatches("RAG", ""), false);
});

/* -------------------------------------------------------------------------- */
/* 2. search：纯函数层的匹配与排序                                              */
/* -------------------------------------------------------------------------- */

/** 造一篇最小可用的 SearchDoc。只填参与匹配/排序的字段，其余给安全默认值。 */
function doc(overrides: {
  slug: string;
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  date?: string;
  body?: string;
}) {
  return {
    slug: overrides.slug,
    title: overrides.title ?? "",
    description: overrides.description ?? "",
    date: overrides.date ?? "2026-01-01",
    tags: overrides.tags ?? [],
    category: overrides.category ?? "未分类",
    draft: false,
    readingTime: 1,
    body: overrides.body ?? "",
  };
}

test("P5 搜索：normalizeQuery / tokenizeQuery 处理全角空格与重复词", () => {
  assert.equal(search.normalizeQuery("  RAG   分块  "), "rag 分块");
  // 中文输入法很容易打出全角空格 `\u3000`，不折成半角就永远匹配不到。
  assert.equal(search.normalizeQuery("机器\u3000学习"), "机器 学习");
  assert.deepEqual(search.tokenizeQuery("rag 分块 rag"), ["rag", "分块"]);
  assert.deepEqual(search.tokenizeQuery("   "), []);
  // 词数上限：超过 8 个词只取前 8 个（防止超长查询把打分拖慢）。
  const many = search.tokenizeQuery("a b c d e f g h i j");
  assert.equal(many.length, search.SEARCH_MAX_TOKENS);
});

test("P5 搜索：isSearchableQuery 区分「没输入」与「没结果」", () => {
  assert.equal(search.isSearchableQuery(""), false);
  assert.equal(search.isSearchableQuery("   "), false);
  assert.equal(search.isSearchableQuery("rag"), true);
  // 超长查询判为不可搜索（页面渲染提示，而不是跑一次全表子串匹配）。
  assert.equal(search.isSearchableQuery("x".repeat(search.SEARCH_MAX_QUERY_LENGTH + 1)), false);
});

test("P5 搜索：matchDoc 是 AND 语义，且按字段顺序返回命中项", () => {
  const d = doc({
    slug: "a",
    title: "RAG 分块策略",
    category: "工程实践",
    tags: ["LLM"],
    body: "正文里提到向量检索。",
  });

  // 两个词都命中 → 返回命中的字段，按 SEARCH_FIELD_ORDER（title 在 tags 前）。
  const hit = search.matchDoc(d, ["rag", "llm"]);
  assert.ok(hit, "两个词都能命中时不该返回 null");
  assert.deepEqual(hit, ["title", "tags"]);

  // 有一个词完全不出现 → 整篇不命中（AND，不是 OR）。
  assert.equal(search.matchDoc(d, ["rag", "不存在的词"]), null);

  // 空词表 → null（不是「全命中」）。
  assert.equal(search.matchDoc(d, []), null);
});

test("P5 搜索：scoreDoc 每词只取最高权重字段，不叠加", () => {
  const d = doc({ slug: "a", title: "RAG", body: "rag rag rag rag" });
  // `rag` 命中标题(5)与正文(1) → 只取 5，不是 6。
  assert.equal(search.scoreDoc(d, ["rag"]), search.SEARCH_FIELD_WEIGHTS.title);
});

test("P5 搜索：rankDocs 得分优先，同分按日期降序，再同按 slug 升序", () => {
  const docs = [
    doc({ slug: "c-only-body", body: "rag", date: "2026-03-01" }),
    doc({ slug: "a-title", title: "RAG", date: "2026-01-01" }),
    doc({ slug: "b-title", title: "RAG", date: "2026-02-01" }),
    doc({ slug: "d-nomatch", title: "无关", body: "无关" }),
  ];

  const ranked = search.rankDocs(docs, ["rag"]);
  assert.deepEqual(
    ranked.map((p) => p.slug),
    // 两个标题命中并列最高分 → 日期新的在前；正文命中排后面；不命中被过滤掉。
    ["b-title", "a-title", "c-only-body"],
  );
});

test("P5 搜索：rankDocs 的结果不带正文（防整篇文章进 RSC payload）", () => {
  const ranked = search.rankDocs([doc({ slug: "a", title: "RAG", body: "很长的正文" })], ["rag"]);
  assert.equal(ranked.length, 1);
  assert.equal("body" in ranked[0], false, "返回的 PostMeta 里不能有 body 字段");
});

test("P5 搜索：searchDocs 对不可搜索查询返回空数组而不是抛错", () => {
  const docs = [doc({ slug: "a", title: "RAG" })];
  assert.deepEqual(search.searchDocs(docs, ""), []);
  assert.deepEqual(search.searchDocs(docs, "   "), []);
  assert.equal(search.searchDocs(docs, "rag").length, 1);
});

/* -------------------------------------------------------------------------- */
/* 3. 两个内容源：getPostsByTag / searchPosts 真的接上了数据                    */
/* -------------------------------------------------------------------------- */

test("P5 内容源：getPostsByTag 大小写不敏感，且返回的文章都带该标签", async () => {
  const upper = await content.getPostsByTag("RAG");
  const lower = await content.getPostsByTag("rag");

  assert.ok(upper.length > 0, "站内确实有带 RAG 标签的文章，不能为空");
  assert.deepEqual(
    upper.map((p) => p.slug),
    lower.map((p) => p.slug),
    "/tags/RAG 与 /tags/rag 必须返回同一批文章（大小写不敏感）",
  );

  // 每篇返回的文章都必须真的含这个标签 —— 防止「过滤条件写反」这类假绿。
  for (const post of upper) {
    assert.ok(
      post.tags.some((name) => tagUrl.tagMatches(name, "rag")),
      `${post.slug} 不含 RAG 标签却被返回`,
    );
  }

  // 不存在的标签返回空数组（页面据此 404），而不是抛错。
  assert.deepEqual(await content.getPostsByTag("绝对不存在的标签"), []);
});

test("P5 内容源：getPostsByTag 覆盖 getAllTags 的每一个标签", async () => {
  const tags = await content.getAllTags();
  assert.ok(tags.length > 0, "getAllTags() 不能为空");

  const allPosts = await content.getAllPosts();
  for (const { tag, count } of tags) {
    const matched = await content.getPostsByTag(tag);
    // 计数口径（精确字符串）与匹配口径（大小写不敏感）不同，
    // 所以只能断言「≥ count」，不能断言相等 —— 但绝不能小于。
    assert.ok(
      matched.length >= count,
      `标签 ${tag} 计数为 ${count}，但 getPostsByTag 只返回 ${matched.length} 篇`,
    );
    assert.ok(matched.length <= allPosts.length, `标签 ${tag} 返回数不能超过文章总数`);
  }
});

test("P5 内容源：searchPosts 只返回文章、按相关度排序、且不带正文", async () => {
  const results = await content.searchPosts("rag");

  assert.ok(results.length > 0, "搜索 rag 必须有结果");
  // 只搜文章：返回的 slug 必须都在 blog 集合里。
  const blogSlugs = new Set((await content.getAllPosts()).map((p) => p.slug));
  for (const item of results) {
    assert.ok(blogSlugs.has(item.slug), `${item.slug} 不是文章却出现在搜索结果里`);
    assert.equal("body" in item, false, "搜索结果不能带正文");
  }

  // 空查询返回空数组（页面靠 isSearchableQuery 区分「没输入」与「没结果」）。
  assert.deepEqual(await content.searchPosts(""), []);

  // 乱码查询返回空数组而不是抛错。
  assert.deepEqual(await content.searchPosts("zzzzzz-不存在-zzzzzz"), []);
});

test("P5 内容源：搜索能命中正文而不只是标题", async () => {
  // 从真实数据里挑一个「只出现在正文、不出现在任何标题」的词。
  // 做法：取每篇文章正文里第一个 ≥ 6 字符的英文标识符，断言它搜得到。
  const docs = posts.getSearchDocs();
  const titles = docs.map((d) => d.title.toLowerCase());

  let probed = 0;
  for (const d of docs) {
    const candidate = (d.body.match(/[a-zA-Z_][a-zA-Z0-9_-]{5,}/g) ?? []).find(
      (word) => !titles.some((title) => title.includes(word.toLowerCase())),
    );
    if (!candidate) continue;

    const hits = await content.searchPosts(candidate);
    assert.ok(
      hits.some((hit) => hit.slug === d.slug),
      `正文里的 ${candidate}（${d.slug}）应该能被搜到，实际结果：${hits.map((h) => h.slug).join(",")}`,
    );
    probed += 1;
    if (probed >= 2) break;
  }

  assert.ok(probed > 0, "没能从真实正文里找到可探测的词 —— 说明 getSearchDocs() 的 body 是空的");
});

test("P5 内容源：getSearchDocs 的 body 是真实正文，不是空串", () => {
  const docs = posts.getSearchDocs();
  assert.equal(docs.length, 4, `应有 4 篇文章的候选文档（实际 ${docs.length}）`);
  for (const d of docs) {
    assert.ok(d.body.length > 50, `${d.slug} 的正文只有 ${d.body.length} 字符，明显没读到`);
    // frontmatter 必须已经被剥离，否则正文里会混进 `title:` `date:` 这些行。
    assert.ok(!d.body.startsWith("---"), `${d.slug} 的 body 里残留了 frontmatter`);
  }
});

/* -------------------------------------------------------------------------- */
/* 4. sitemap：标签总览进 sitemap，搜索结果页刻意不进                            */
/* -------------------------------------------------------------------------- */

test("P5 sitemap：/tags 在 sitemap 里，/search 不在", async () => {
  const routes = await sitemapModule.default();
  const urls = routes.map((r) => r.url);

  assert.ok(
    urls.some((u) => u.endsWith("/tags")),
    "标签总览页必须进 sitemap（它是稳定入口）",
  );
  assert.ok(
    !urls.some((u) => u.includes("/search")),
    "搜索结果页不能进 sitemap —— 每条 query 都是独立 URL，收录进去等于制造无穷重复页",
  );

  // 每个标签都要有一条自己的 URL，且必须与 tagHref() 生成的完全一致
  // （再拼一次 base）。这条是「URL 稳定」的硬要求：`/tags/RAG` 与 `/tags/rag`
  // 不能同时存在，否则两个 URL 指向同一内容，搜索引擎会判重复页。
  const tags = await content.getAllTags();
  assert.ok(tags.length > 0, "getAllTags() 不能为空");

  const tagUrls = urls.filter((u) => u.includes("/tags/"));
  assert.equal(
    tagUrls.length,
    tags.length,
    `标签详情应有 ${tags.length} 条（实际 ${tagUrls.length}）`,
  );

  const base = urls.find((u) => u.endsWith("/tags"))!.replace(/\/tags$/, "");
  for (const { tag } of tags) {
    const expected = `${base}${tagUrl.tagHref(tag)}`;
    assert.ok(
      urls.includes(expected),
      `sitemap 缺少标签页 ${expected}（标签原文 ${tag}）`,
    );
  }

  // 标签 URL 必须已经归一化成小写：不允许出现两个只差大小写的 URL。
  const lowered = tagUrls.map((u) => u.toLowerCase());
  assert.equal(
    new Set(lowered).size,
    lowered.length,
    "sitemap 里出现了只差大小写的重复标签 URL",
  );
});
