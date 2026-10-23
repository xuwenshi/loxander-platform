/**
 * P5 端到端接线测试：真实数据下，搜索 / 标签 / 媒体 / 健康检查四条链路是否真的通。
 *
 * ── 为什么还需要这个文件（p5-wiring.test.ts 已经全绿了）─────────────────
 * `p5-wiring.test.ts` 验的是「模块能加载、纯函数语义对、四个 lib 接上了数据」，
 * 它跑的是 **markdown 内容源**（默认 `CONTENT_SOURCE=markdown`）。
 * 但 P5 的验收要求是「P3 之后公开站读库」，也就是说真正要在生产上跑的是
 * **db 内容源**：真实的 `entries` / `tags` / `entry_tags` 表，真实的 `body_md`。
 *
 * 这两条路上的差异恰恰是「测试绿、线上红」的高发区：
 * - 搜索要打正文分，markdown 源的 `body` 来自 `fs.readFileSync`，
 *   db 源来自 `body_md` 列 —— 列写错了、trim 掉了、或者干脆是空串，
 *   函数签名照样对，`tsc` 照样过，只有真查一次库才看得见；
 * - 标签在两路来自完全不同的结构（frontmatter 数组 vs 两张关系表 JOIN），
 *   关系表漏写 `tag_order` 或漏 JOIN，`/tags/[tag]` 会静默变空；
 * - 媒体引用检查只走 `getAdminDb()`（后台写路径），它扫的是 `data->>'cover'`
 *   与 `body_md`，这两列在 markdown 源里根本不存在；
 * - 健康检查的 `buildHealthReport()` 只有三条分支，全部依赖「注入的库到底能不能执行语句」。
 *
 * 所以本文件的定位很明确：**同一个 PGlite（真迁移 + 真导入真内容）上，
 * 把四条链路各跑一遍，每条断言都必须有真实数据支撑。**
 * 这里不 mock 任何业务逻辑 —— 唯一的替身是 `server-only`（非 RSC 环境会抛错）
 * 与 `next/cache`（`cacheTag()` 要求 `__NEXT_USE_CACHE`，只有 Next 编译器会注入），
 * 两者都是**运行环境**替身，不是业务逻辑替身，且 `next-cache-stub.ts` 会把
 * 打过的标签记下来，测试顺带可以断言。
 *
 * ── 为什么把 NODE_ENV 设成 production ─────────────────────────────────
 * 草稿过滤的判据是 `sources/db.ts:188` 的
 * `const includeDrafts = process.env.NODE_ENV !== "production"`。
 * 它是**模块顶层常量**，在 import 那一刻求值一次。
 * 如果测试进程跑在默认（NODE_ENV 未设置 = 开发）下，草稿也是可见的，
 * 于是「把一篇改成 draft 之后它从搜索结果里消失」这条用例会**假绿**：
 * 不管过滤逻辑有没有写对，都看不见差异。
 *
 * 生产语义才是要被验证的那一套（公开站就是 production），所以本文件在
 * 任何业务模块被 import **之前**把 NODE_ENV 设成 production。
 * 反过来说，开发环境「能看到草稿」这条行为也值得留证据 ——
 * 见文件末尾「开发环境与生产环境的可见性差异」那条用例：它用带 query 的
 * 模块 URL 重新 import 一次 `sources/db.ts`（ESM 缓存以完整 URL 为键），
 * 拿到一个 `includeDrafts = true` 的实例再比对两边的行数。
 *
 * ── 为什么自己写一份 createSeededDatabase ─────────────────────────────
 * 同目录 `sources/__tests__/content-source.test.ts` 里那份是**函数内私有**的，
 * 而 import 一个 `*.test.ts` 会把那个文件里的全部 `test()` 一起注册进当前进程
 * （node:test 是全局注册表），用例计数立刻混在一起，失败原因也分不清是谁的。
 * 所以这里复用它的**做法**（真迁移 0000 + 0001、真 `mapEntry`、真 `renderMarkdown`、
 * 真 `tags`/`entry_tags` 关系），不 import 它。
 *
 * 跑法（仓库根 `loxander-platform/`）：
 *   node --test-isolation=none apps/web/src/lib/__tests__/p5-e2e.test.ts
 * 注意 `node --test <file>` 在本机不可用（默认每个文件 fork 一个子进程，
 * 沙箱禁止管道 stdio → `spawn EPERM`），必须带 `--test-isolation=none`。
 */

/* -------------------------------------------------------------------------- */
/* 引导：resolve hook（.ts 后缀 / @/ 别名 / server-only / next-cache）+ cwd      */
/* -------------------------------------------------------------------------- */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `apps/web/src`（本文件在 `src/lib/__tests__/` 下，往上两层）。 */
const SRC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
/** `apps/web`。 */
const WEB_DIR = resolvePath(SRC_DIR, "..");
/** 仓库根 `loxander-platform`。 */
const REPO_DIR = resolvePath(WEB_DIR, "..", "..");

/** 真实包在非 react-server 条件下解析到会抛错的入口，测试里换成空模块。 */
const SERVER_ONLY_EMPTY = resolvePath(REPO_DIR, "node_modules/server-only/empty.js");
/** 记录 `cacheTag()` 参数的空实现（见同目录 `sources/__tests__/next-cache-stub.ts`）。 */
const NEXT_CACHE_STUB = resolvePath(SRC_DIR, "lib/sources/__tests__/next-cache-stub.ts");

/**
 * `process.env` 的「可写字典」视图。
 *
 * `@types/node` 把 `NODE_ENV` 声明成只读的窄联合
 * （`readonly NODE_ENV: "development" | "production" | "test"`），
 * 因此 `process.env.NODE_ENV = ...` 与 `delete process.env.NODE_ENV`
 * 都过不了 `tsc`（TS2540 / TS2704）。但那是**类型声明**的表达限制，
 * 不是运行时限制：Node 允许给 `process.env` 写任意字符串、也允许 delete。
 *
 * 本文件恰恰必须在同一进程里切换取值（生产语义 / 开发语义各验一遍），
 * 所以统一走这个视图。不用 `as any`：值域仍是 `string | undefined`，
 * 写错类型照样会被拦住。全文所有 NODE_ENV 的读 / 写 / 删都走它。
 */
const env = process.env as Record<string, string | undefined>;

/**
 * 生产语义：必须在任何业务模块被 import 之前设好。
 * 理由见文件头「为什么把 NODE_ENV 设成 production」。
 */
const ORIGINAL_NODE_ENV = env.NODE_ENV;
env.NODE_ENV = "production";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: pathToFileURL(SERVER_ONLY_EMPTY).href, shortCircuit: true };
    }
    if (specifier === "next/cache") {
      return { url: pathToFileURL(NEXT_CACHE_STUB).href, shortCircuit: true };
    }

    // `next` 包没有 `exports` 字段，`next/server` 之类在纯 node 下解析不到，补 `.js`。
    // 本文件目前不 import 这些，但库文件将来加了也不会让整个套件炸掉。
    if (specifier.startsWith("next/")) {
      const candidate = resolvePath(REPO_DIR, "node_modules", `${specifier}.js`);
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }

    // tsconfig 的 `paths`：`@/*` → `apps/web/src/*`。
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

// 四个旧 lib 用 `path.join(process.cwd(), "content", ...)` 定位 markdown，
// `db/mapping.ts` 用 cwd 找 `public/`，站点的运行时 cwd 就是 `apps/web`。
process.chdir(WEB_DIR);

import { after, before, test } from "node:test";
import assert from "node:assert/strict";

/* -------------------------------------------------------------------------- */
/* 引导之后才能加载被测代码                                                     */
/* -------------------------------------------------------------------------- */

const requireFromRepo = createRequire(pathToFileURL(resolvePath(REPO_DIR, "package.json")).href);
/** 依赖在仓库根 node_modules（npm workspaces hoist），绕开 `@/` 别名直接解析。 */
const importFromRepo = (name: string): Promise<never> =>
  import(pathToFileURL(requireFromRepo.resolve(name)).href) as Promise<never>;

/** `CONTENT_SOURCE=db`：让 `lib/content.ts` 走数据库实现（P3 之后的生产形态）。 */
env.CONTENT_SOURCE = "db";

const content = (await import("@/lib/content")) as typeof import("../content");
const contentSource = (await import("@/lib/content-source")) as typeof import("../content-source");
const tagUrl = (await import("@/lib/tag-url")) as typeof import("../tag-url");
const health = (await import("@/lib/health")) as typeof import("../health");
const mediaRefs = (await import("@/lib/media/references")) as typeof import("../media/references");
const dbSourceModule = (await import("@/lib/sources/db")) as typeof import("../sources/db");
const adminDbModule = (await import("@/lib/admin/db")) as typeof import("../admin/db");

const schema = (await import(
  pathToFileURL(resolvePath(REPO_DIR, "db/schema.ts")).href
)) as typeof import("../../../../../db/schema");
const { entries, tags: tagsTable, entryTags, entryRevisions } = schema;

const drizzleOrm = (await importFromRepo("drizzle-orm")) as {
  and: (...conditions: unknown[]) => unknown;
  eq: (left: unknown, right: unknown) => unknown;
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
};

/**
 * 以「开发环境」语义重新加载一份 `lib/sources/db.ts`。
 *
 * {@link dbSourceModule} 是在文件头把 `NODE_ENV` 设成 production 之后才加载的，
 * 它内部的 `const includeDrafts = ...`（`sources/db.ts:188`）就永远为 false。
 * 要验「开发环境能看到草稿」，只能拿到一个**在开发环境下求值过的**模块实例。
 *
 * ESM 的模块缓存键是完整 URL，所以给同一个文件换个 query 就是另一个实例、
 * 另一份模块作用域 —— `includeDrafts` 会按当时的 NODE_ENV 重新算一遍。
 * 注意这个实例与主实例**互不共享**注入点，必须各自 `setDbContentSourceDatabase()`。
 */
async function importDevInstance(url: string): Promise<typeof dbSourceModule> {
  const saved = env.NODE_ENV;
  env.NODE_ENV = "development";
  try {
    return (await import(url)) as typeof dbSourceModule;
  } finally {
    env.NODE_ENV = saved;
  }
}

/* -------------------------------------------------------------------------- */
/* 建库：真迁移 + 真导入 10 篇真内容                                             */
/* -------------------------------------------------------------------------- */

/** 一篇真实内容的清单项：读盘得到的原文 + slug + kind。 */
interface SourceFile {
  kind: "blog" | "diary" | "projects" | "goals";
  slug: string;
  raw: string;
}

/** 10 个真实文件（顺序 = 目录内文件名升序，与四个 lib 的读法一致）。 */
function realFiles(): SourceFile[] {
  const kinds = ["blog", "diary", "projects", "goals"] as const;
  const files: SourceFile[] = [];

  for (const kind of kinds) {
    const dir = resolvePath(WEB_DIR, "content", kind);
    for (const name of readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .sort()) {
      files.push({
        kind,
        slug: name.replace(/\.md$/, ""),
        raw: readFileSync(join(dir, name), "utf8"),
      });
    }
  }

  return files;
}

/** 一个跑过全部迁移、装好真实内容的 PGlite + drizzle 实例。 */
interface Seeded {
  client: { close: () => Promise<void> };
  db: unknown;
  files: SourceFile[];
}

/**
 * 起 PGlite，按 `db/migrations/meta/_journal.json` 的顺序跑**全部**迁移，
 * 再用**真的** `mapEntry` + **真的** `renderMarkdown` 把 10 篇内容写进去。
 *
 * 关键点（每条都是踩过的坑）：
 * 1. 迁移必须全跑：漏掉 `0001_entry_tag_order.sql` 会让读标签的 JOIN 报
 *    `column entry_tags.tag_order does not exist`；
 * 2. `body_html` 必须按 `renderOptionsForKind(kind)` 渲染（goals 是 offset 2），
 *    否则 `db/compare.ts` 的维度 5 会报差异 —— 本文件不比对 html，
 *    但导入路径必须与生产一致，否则测的就不是同一份数据；
 * 3. `tags` 表按 `tagSlugOf(name)` 去重，`entry_tags.tag_order` 写 frontmatter 下标，
 *    标签顺序才能被还原（`PostCard` 的 `tags.slice(0, 4)` 依赖它）。
 */
async function createSeededDatabase(): Promise<Seeded> {
  const { PGlite } = (await importFromRepo("@electric-sql/pglite")) as unknown as {
    PGlite: new () => { exec: (sql: string) => Promise<unknown>; close: () => Promise<void> };
  };
  const { drizzle } = (await importFromRepo("drizzle-orm/pglite")) as unknown as {
    drizzle: (client: unknown, options: unknown) => unknown;
  };
  const { mapEntry, renderOptionsForKind, tagSlugOf } = (await import(
    pathToFileURL(resolvePath(REPO_DIR, "db/mapping.ts")).href
  )) as {
    mapEntry: (
      kind: string,
      slug: string,
      raw: string,
      ctx: { publicDir: string; knownBlogSlugs?: readonly string[] },
    ) => {
      ok: boolean;
      row: Record<string, unknown>;
      tags: string[];
      body: string;
    };
    renderOptionsForKind: (kind: string) => { headingOffset: number };
    tagSlugOf: (name: string) => string;
  };
  const { renderMarkdown } = (await import(
    pathToFileURL(resolvePath(REPO_DIR, "packages/markdown/src/index.ts")).href
  )) as { renderMarkdown: (md: string, options?: unknown) => Promise<string> };

  const client = new PGlite();

  const migrationDir = resolvePath(REPO_DIR, "db/migrations");
  const journal = JSON.parse(readFileSync(resolvePath(migrationDir, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const migration of journal.entries) {
    await client.exec(readFileSync(resolvePath(migrationDir, `${migration.tag}.sql`), "utf8"));
  }

  const db = drizzle(client, { schema }) as unknown as {
    insert: (table: unknown) => { values: (value: unknown) => Promise<unknown> };
    select: () => { from: (table: unknown) => Promise<unknown[]> };
  };

  const files = realFiles();
  const knownBlogSlugs = files.filter((file) => file.kind === "blog").map((file) => file.slug);

  /** `tagSlugOf(name)` → 名称；顺序即插入顺序。 */
  const tagNameOfSlug = new Map<string, string>();
  /** entry key（`kind/slug`）→ 该行标签名数组（下标即 tag_order）。 */
  const tagsOfEntry = new Map<string, string[]>();

  for (const file of files) {
    const mapped = mapEntry(file.kind, file.slug, file.raw, {
      publicDir: resolvePath(WEB_DIR, "public"),
      knownBlogSlugs,
    });
    assert.equal(mapped.ok, true, `${file.kind}/${file.slug} 映射失败，种子数据不可信`);
    const html = await renderMarkdown(mapped.body, renderOptionsForKind(file.kind));
    await db.insert(entries).values({ ...mapped.row, body_html: html });

    if (mapped.tags.length > 0) {
      tagsOfEntry.set(`${file.kind}/${file.slug}`, mapped.tags);
      for (const name of mapped.tags) tagNameOfSlug.set(tagSlugOf(name), name);
    }
  }

  const slugs = [...tagNameOfSlug.keys()];
  if (slugs.length > 0) {
    await db
      .insert(tagsTable)
      .values(slugs.map((slug) => ({ slug, name: tagNameOfSlug.get(slug) ?? slug })));
  }

  const entryRows = (await db.select().from(entries)) as { id: string; kind: string; slug: string }[];
  const entryIdOfKey = new Map(entryRows.map((row) => [`${row.kind}/${row.slug}`, row.id]));

  const tagRows = (await db.select().from(tagsTable)) as { id: number; slug: string }[];
  const tagIdOfSlug = new Map(tagRows.map((row) => [row.slug, row.id]));

  const links: { entry_id: string; tag_id: number; tag_order: number }[] = [];
  for (const [key, names] of tagsOfEntry) {
    const entryId = entryIdOfKey.get(key);
    assert.ok(entryId, `找不到 ${key} 的 entry id`);
    names.forEach((name, order) => {
      const tagId = tagIdOfSlug.get(tagSlugOf(name));
      assert.ok(tagId !== undefined, `找不到标签 ${name} 的 id`);
      links.push({ entry_id: entryId, tag_id: tagId, tag_order: order });
    });
  }
  if (links.length > 0) {
    await db.insert(entryTags).values(links);
  }

  return { client: client as unknown as { close: () => Promise<void> }, db: db as unknown, files };
}

/* -------------------------------------------------------------------------- */
/* 共享库：只读用例（搜索 / 标签 / 媒体 / 健康检查 ok 分支）                     */
/* -------------------------------------------------------------------------- */

/**
 * 只读用例共用同一个库。
 *
 * 为什么不是每条用例各建一个：建库 = 17 条迁移 + 10 次 Shiki 渲染，
 * 单次约 2 秒；11 条用例各建一次等于把套件拖到 20 秒以上，
 * 而只读用例之间没有任何写操作，共享不会互相污染。
 * 会写库的两条（改草稿、插一条引用图的内容）各自建库，见那两条用例的注释。
 */
let shared: Seeded;
/** 只读用例的默认 blog slug（下面按真实数据挑，不硬编码顺序）。 */
let sharedBlogSlugs: string[] = [];

before(async () => {
  shared = await createSeededDatabase();
  dbSourceModule.setDbContentSourceDatabase(shared.db as never);
  adminDbModule.setAdminDatabase(shared.db as never);
  contentSource.resetContentSource();
  sharedBlogSlugs = (await content.getBlogSlugs()).slice();
});

after(async () => {
  dbSourceModule.setDbContentSourceDatabase(undefined);
  adminDbModule.setAdminDatabase(undefined);
  contentSource.resetContentSource();
  delete env.CONTENT_SOURCE;
  await shared?.client.close();
  if (ORIGINAL_NODE_ENV === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = ORIGINAL_NODE_ENV;
});

/* -------------------------------------------------------------------------- */
/* 一、搜索：真实数据下真的按「已发布 + 不带正文」返回                            */
/* -------------------------------------------------------------------------- */

test("搜索（db 源）：命中结果全部是已发布内容，且不带正文", async () => {
  // 查询词选真实正文里出现的词：
  // `rag-chunking-strategies.md:1` 的标题里有「分块策略」，
  // 而 `RAG` 同时出现在标题 / tags / 正文中（`lib/search.ts` 的五字段都会打分）。
  // 不用「平台」：那是 projects 的 `name`（`personal-blog-platform.md:2`），
  // 而搜索范围按设计只有 blog（`lib/search.ts:15-19`），拿它当探针会得到空集，
  // 那样这条断言看起来会「通过」但什么都没验到。
  const results = await content.searchPosts("分块");

  assert.ok(results.length > 0, "「分块」是文章标题里的词，搜索结果不能为空");

  // 1) 逐条回库确认 publish_status —— 不能只看 PostMeta.draft，
  //    因为 `draft` 是映射出来的布尔值，而「库里到底是什么状态」才是验收对象。
  const rows = (await (shared.db as unknown as {
    select: () => { from: (table: unknown) => Promise<{ slug: string; publish_status: string }[]> };
  })
    .select()
    .from(entries)) as { slug: string; publish_status: string }[];
  const statusOfSlug = new Map(rows.map((row) => [row.slug, row.publish_status]));

  for (const item of results) {
    assert.equal(
      statusOfSlug.get(item.slug),
      "published",
      `${item.slug} 出现在搜索结果里，但库里的 publish_status 不是 published`,
    );
    assert.equal(item.draft, false, `${item.slug} 的 draft 应为 false`);
  }

  // 2) 只搜文章：返回的 slug 必须都在 blog 分区里。
  const blogSlugs = new Set(sharedBlogSlugs);
  for (const item of results) {
    assert.ok(blogSlugs.has(item.slug), `${item.slug} 不是文章却出现在搜索结果里`);
  }

  // 3) 结果按相关度排序：`分块` 是 rag-chunking 的标题词（权重 5），
  //    它必须排在任何「只在正文命中」（权重 1）的文章前面。
  assert.equal(results[0].slug, "rag-chunking-strategies", "标题命中必须排在正文命中之前");
});

test("搜索（db 源）：结果对象里没有 body 键（正文不进 RSC payload）", async () => {
  const results = await content.searchPosts("RAG");
  assert.ok(results.length > 0, "RAG 是真实标签兼标题词，必须有结果");

  // `lib/search.ts:203-217` 的 toPostMeta 显式丢掉 body。
  // 这里不只断言「没有 body」，而是把允许的键固定下来 ——
  // 将来有人往 rankDocs 的返回值里多塞一个 `body_md`，这条会立刻红。
  const allowed = new Set([
    "slug",
    "title",
    "description",
    "date",
    "tags",
    "category",
    "cover",
    "coverWidth",
    "coverHeight",
    "draft",
    "readingTime",
  ]);

  for (const item of results) {
    assert.equal("body" in item, false, `${item.slug} 的搜索结果带了 body`);
    assert.equal("body_md" in item, false, `${item.slug} 的搜索结果带了 body_md`);
    for (const key of Object.keys(item)) {
      assert.ok(allowed.has(key), `${item.slug} 出现了未预期的键 ${key}`);
    }
    // 正文是搜索的打分依据，所以「没有 body」不代表「没读过正文」——
    // readingTime 是从正文算出来的，它是「正文真的被读到过」的旁证。
    assert.ok(item.readingTime >= 1, `${item.slug} 的 readingTime 不合理，说明正文没读到`);
  }
});

test("搜索（db 源）：空查询与纯空白查询返回空数组，不抛错", async () => {
  // 页面靠 `isSearchableQuery` 区分「没输入」与「没结果」，
  // 所以内容源这一层必须给空数组而不是全量（更不是抛错）。
  assert.deepEqual(await content.searchPosts(""), []);
  assert.deepEqual(await content.searchPosts("   "), []);
  // 全角空格也是空白（中文输入法常见），同样必须判为不可搜索。
  assert.deepEqual(await content.searchPosts("\u3000\u3000"), []);
});

test("搜索（db 源）：正文里真实存在、但标题里没有的词也能被搜到", async () => {
  // 从真实正文里挑一个「只出现在 body_md、不出现在任何标题」的长标识符，
  // 这条是「db 源的搜索确实读了 body_md 列」的唯一直接证据：
  // 若 searchPosts 忘了把 body_md 塞进 SearchDoc，标题仍然命中的用例全绿，
  // 只有这条会红。
  const posts = await content.getAllPosts();
  const titles = posts.map((post) => post.title.toLowerCase());

  const rows = (await (shared.db as unknown as {
    select: () => { from: (table: unknown) => Promise<{ slug: string; body_md: string }[]> };
  })
    .select()
    .from(entries)) as { slug: string; body_md: string }[];

  let probed = 0;
  for (const row of rows) {
    const candidate = (row.body_md.match(/[a-zA-Z_][a-zA-Z0-9_-]{5,}/g) ?? []).find(
      (word) => !titles.some((title) => title.includes(word.toLowerCase())),
    );
    if (!candidate) continue;

    const hits = await content.searchPosts(candidate);
    assert.ok(
      hits.some((hit) => hit.slug === row.slug),
      `正文里的 ${candidate}（${row.slug}）应该能被搜到，实际返回：${hits.map((h) => h.slug).join(",")}`,
    );
    probed += 1;
    if (probed >= 2) break;
  }

  assert.ok(probed > 0, "没能从真实正文里找到可探测的词 —— body_md 可能是空的");
});

/* -------------------------------------------------------------------------- */
/* 二、草稿过滤：证明它发生在内容源里，不在 search.ts 里                          */
/* -------------------------------------------------------------------------- */

test("搜索（db 源）：把一篇改成 draft 后，它从搜索结果里消失（生产语义）", async () => {
  // 这条必须用**独立的库**：它要写一行再还原，共享库被写脏会影响其他用例的计数。
  const seeded = await createSeededDatabase();
  dbSourceModule.setDbContentSourceDatabase(seeded.db as never);
  contentSource.resetContentSource();

  const targetSlug = "rag-chunking-strategies";
  // 查询词选 `RAG` 而不是「分块」：`分块` 只出现在 rag-chunking 一篇里
  // （真实数据实测 8 处，全在同一文件），把这篇改成 draft 之后搜索结果是**空集**，
  // 那样「其他文章仍应被搜到」这条反向断言无从成立，只能删掉 ——
  // 删掉就少了一道防线（过滤条件写成「全删」也会绿）。
  // `RAG` 同时命中 rag-chunking 与 langgraph-rag-workflow（两篇的 tags 里都有），
  // 一篇变草稿之后另一篇必须还搜得到。
  const query = "RAG";
  const otherSlug = "langgraph-rag-workflow";

  try {
    const before = await content.searchPosts(query);
    assert.ok(
      before.some((item) => item.slug === targetSlug),
      "前置条件：这篇本来是已发布且能被搜到的",
    );
    assert.ok(
      before.some((item) => item.slug === otherSlug),
      `前置条件：${otherSlug} 也应被「${query}」搜到（否则下面的反向断言没有意义）`,
    );

    // 直接用 drizzle 改库（不是调用后台 action）—— 本文件验的是**读路径**的过滤，
    // 写路径（七道关、审计、乐观锁）由 `admin-actions.test.ts` 负责。
    const db = seeded.db as unknown as {
      update: (table: unknown) => {
        set: (value: unknown) => { where: (condition: unknown) => Promise<unknown> };
      };
    };
    await db
      .update(entries)
      .set({ publish_status: "draft" })
      .where(
        drizzleOrm.and(
          drizzleOrm.eq(entries.kind, "blog"),
          drizzleOrm.eq(entries.slug, targetSlug),
        ),
      );

    // 搜索：必须消失。
    // 注意 `lib/search.ts:21-27` 明确写了「本文件不做草稿过滤」——
    // 过滤在 `sources/db.ts:191-193 visibleOnly()` 与 `loadRows` 里。
    // 所以这条用例红的时候，责任方是内容源，不是搜索。
    const after = await content.searchPosts(query);
    assert.equal(
      after.some((item) => item.slug === targetSlug),
      false,
      "改成 draft 之后仍然被搜到 —— 说明草稿过滤没有发生在内容源里",
    );

    // 列表也必须消失（同一份 `loadRows`，两条路一起验才不会漏掉某一条忘了套过滤）。
    const listed = await content.getAllPosts();
    assert.equal(
      listed.some((item) => item.slug === targetSlug),
      false,
      "改成 draft 之后仍然出现在 getAllPosts() 里",
    );

    // 反向确认：不是「整个 blog 都空了」（那种情况上面两条也会绿，但语义完全不同）。
    assert.ok(
      after.some((item) => item.slug === otherSlug),
      `把一篇改成草稿后，另一篇（${otherSlug}）仍应被搜到 —— 否则过滤写成了「全删」`,
    );
    assert.ok(listed.length > 0, "除了被改的那篇，其他文章仍应在列表里");
  } finally {
    // 必须把注入点还回共享库再关自己的库：
    // 否则后续用例的 `getAdminDb()` / `getDb()` 会拿到一个已关闭的 PGlite，
    // 报 `DrizzleQueryError: ... cause: Error: PGlite is closed`（踩过）。
    dbSourceModule.setDbContentSourceDatabase(shared.db as never);
    contentSource.resetContentSource();
    await seeded.client.close();
  }
});

test("搜索（db 源）：开发环境仍能看到草稿（与生产语义的差异是 NODE_ENV 驱动的）", async () => {
  // `includeDrafts` 是模块顶层常量（`sources/db.ts:188`），改 NODE_ENV 之后
  // 必须重新求值一次才有意义。ESM 的缓存键是**完整 URL**，
  // 所以给同一个文件加一个 query 就能拿到第二个实例（互不干扰的 module 作用域）。
  const seeded = await createSeededDatabase();
  const devDbUrl = `${pathToFileURL(resolvePath(SRC_DIR, "lib/sources/db.ts")).href}?dev-mode=1`;

  const savedNodeEnv = process.env.NODE_ENV;
  let devModule: typeof dbSourceModule | undefined;

  try {
    // 先把这个库切成「有一篇草稿」的状态。
    const db = seeded.db as unknown as {
      update: (table: unknown) => {
        set: (value: unknown) => { where: (condition: unknown) => Promise<unknown> };
      };
    };
    await db
      .update(entries)
      .set({ publish_status: "draft" })
      .where(
        drizzleOrm.and(
          drizzleOrm.eq(entries.kind, "blog"),
          drizzleOrm.eq(entries.slug, "rag-chunking-strategies"),
        ),
      );

    // 两个实例都必须指向**同一个库**，否则比的不是 NODE_ENV 而是两份数据。
    // （踩过：只给 dev 实例注入 seeded.db，主实例还连着共享库，结果 4 vs 4，
    //  看起来像「草稿过滤失效」，其实是 prod 那边压根没看到那篇草稿。）
    devModule = await importDevInstance(devDbUrl);
    devModule.setDbContentSourceDatabase(seeded.db as never);
    dbSourceModule.setDbContentSourceDatabase(seeded.db as never);

    const devPosts = await devModule.createDbContentSource().getAllPosts();
    const prodPosts = await dbSourceModule.createDbContentSource().getAllPosts();

    // 生产实例的 includeDrafts 在模块加载时就已经定成 false（文件头把 NODE_ENV
    // 设成 production 的时机早于任何业务 import），所以这里只可能是 3 篇。
    assert.equal(
      prodPosts.length,
      3,
      `生产环境应只看到 3 篇已发布文章（实际 ${prodPosts.length}）`,
    );
    assert.equal(
      devPosts.length,
      prodPosts.length + 1,
      `开发环境应比生产环境多看到 1 篇草稿（实际 ${devPosts.length} vs ${prodPosts.length}）`,
    );
    assert.ok(
      devPosts.some((post) => post.slug === "rag-chunking-strategies"),
      "开发环境应能看到草稿",
    );
    assert.equal(
      prodPosts.some((post) => post.slug === "rag-chunking-strategies"),
      false,
      "生产环境不应看到草稿",
    );
  } finally {
    env.NODE_ENV = savedNodeEnv as string | undefined;
    devModule?.setDbContentSourceDatabase(undefined);
    // 主实例的注入点还回共享库（共享库由 after() 关闭）。
    dbSourceModule.setDbContentSourceDatabase(shared.db as never);
    contentSource.resetContentSource();
    await seeded.client.close();
  }
});

/* -------------------------------------------------------------------------- */
/* 三、标签：关系表 JOIN 出来的标签与 URL 归一化要能对上                          */
/* -------------------------------------------------------------------------- */

test("标签：每个标签的 getPostsByTag 数量与 getAllTags 的计数一致", async () => {
  const tagCounts = await content.getAllTags();
  assert.ok(tagCounts.length > 0, "真实内容有标签，getAllTags() 不能为空");

  const allPosts = await content.getAllPosts();
  assert.ok(allPosts.length > 0, "真实内容有文章");

  for (const { tag, count } of tagCounts) {
    // 计数口径（精确字符串）与匹配口径（大小写不敏感）本身是两套：
    // `lib/posts.ts:250-256` 明确写了「getAllTags 如实、getPostsByTag 稳定」。
    // 只有当某个标签存在「只差大小写」的兄弟时，两者才会在数量上分叉。
    // 真实内容里没有这种碰撞（下面这条断言守着），所以这里直接要求相等；
    // 一旦将来真出现 `RAG` / `rag` 两个标签，这条会红，那时应当改成
    // 「≥ count」并补一条说明，而不是把断言删掉 —— 删掉就等于不再保护计数。
    const hasCaseSibling = tagCounts.some(
      (other) => other.tag !== tag && other.tag.toLowerCase() === tag.toLowerCase(),
    );

    const matched = await content.getPostsByTag(tag);
    assert.equal(
      matched.length,
      count,
      `标签「${tag}」计数为 ${count}，但 getPostsByTag 返回 ${matched.length} 篇` +
        (hasCaseSibling ? "（存在只差大小写的兄弟标签，口径需要用 ≥ 而非 ===）" : ""),
    );

    // 逐篇确认「返回的文章真的带这个标签」，防止过滤条件写反这类假绿。
    for (const post of matched) {
      assert.ok(
        post.tags.some((name) => tagUrl.tagMatches(name, tag)),
        `${post.slug} 不含标签「${tag}」却被返回`,
      );
    }
  }
});

test("标签：库里写 \"RAG\"，用小写 \"rag\" 查得出来（大小写不敏感）", async () => {
  const tagCounts = await content.getAllTags();
  const upper = tagCounts.find((entry) => entry.tag === "RAG");
  assert.ok(upper, "真实内容里应有大写标签 RAG（`rag-chunking-strategies.md:6`）");

  const byUpper = await content.getPostsByTag("RAG");
  const byLower = await content.getPostsByTag("rag");
  const byMixed = await content.getPostsByTag("RaG");

  assert.ok(byUpper.length > 0, "RAG 标签应至少命中一篇文章");
  assert.deepEqual(
    byLower.map((post) => post.slug),
    byUpper.map((post) => post.slug),
    "/tags/rag 与 /tags/RAG 必须返回同一批文章",
  );
  assert.deepEqual(
    byMixed.map((post) => post.slug),
    byUpper.map((post) => post.slug),
    "大小写任意组合都必须等价",
  );

  // 展示用的标签名仍是原样（`RAG`），只有 URL 归一化 —— 这是 tag-url.ts 的设计：
  // 存储如实、URL 稳定，两者不能互相污染。
  assert.ok(
    byLower.every((post) => post.tags.includes("RAG")),
    "返回的文章里标签名应保持原样 RAG，而不是被 URL 归一化改写",
  );
});

test("标签 URL：tagHref 产出的段用 decodeTagParam 解得回原标签（空格 / 中文 / 斜杠）", async () => {
  /** 从 `/tags/<段>` 里取出段并解码，与页面 `[tag]` 收到的值同构。 */
  const segmentOf = (href: string): string => href.slice(tagUrl.TAGS_PATH.length + 1);

  // 1) 真实存在的标签：走一遍「标签名 → URL → 路由参数 → 再匹配」的完整闭环，
  //    并确认用这个段真的能筛出文章（不只是字符串相等）。
  const realTags = await content.getAllTags();
  for (const { tag } of realTags) {
    const href = tagUrl.tagHref(tag);
    assert.ok(href.startsWith(`${tagUrl.TAGS_PATH}/`), `${tag} 的链接应在 ${tagUrl.TAGS_PATH} 下`);

    const segment = segmentOf(href);
    assert.equal(
      tagUrl.decodeTagParam(segment),
      tagUrl.tagSlugOfName(tag),
      `标签「${tag}」的 URL 无法可逆还原`,
    );
    assert.equal(
      tagUrl.tagMatches(tag, segment),
      true,
      `标签「${tag}」经 URL 往返后不再匹配自己的路由段`,
    );

    const matched = await content.getPostsByTag(segment);
    assert.ok(matched.length > 0, `用 /tags/${segment} 应能筛出文章（标签 ${tag}）`);
  }

  // 2) 真实数据里没有、但归一化必须撑住的三类标签（纯函数语义）。
  //    这三类不是编出来的：中文标签库里就有（向量检索），
  //    `Next.js` 有，含斜杠/空格的标签是「作者随时可能写出来」的形态。
  // 段的值是**手写的字面量**，不是 `encodeURIComponent(name)` 现算 ——
  // 现算的话「实现 = 期望」，断言恒真，等于没测。
  // 这三个字面量已实测核对：`tagHref` 先 `tagSlugOfName`（trim + toLowerCase）
  // 再 `encodeURIComponent`，所以 `Next.js/React` → `next.js%2Freact`（斜杠被编码）、
  // `C++` → `c%2B%2B`（加号被编码成 `%2B`，不是裸 `+` —— 裸 `+` 是空格的旧写法）。
  //
  // `C++` 曾经走不通（`decodeTagParam` 把已解码的 `+` 又当了一次空格，剩 `"c"`），
  // 是 task-13 的这条用例抓出来、Lead 在 `lib/tag-url.ts:90-98` 修掉的。
  // 现在它是正常用例的一部分，见下面单独那条回归守护。
  const synthetic: { name: string; segment: string }[] = [
    {
      name: "机器学习 基础",
      segment: "%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0%20%E5%9F%BA%E7%A1%80",
    },
    { name: "Next.js/React", segment: "next.js%2Freact" },
    { name: "C++", segment: "c%2B%2B" },
  ];

  for (const { name, segment } of synthetic) {
    assert.equal(
      segmentOf(tagUrl.tagHref(name)),
      segment,
      `标签「${name}」的 URL 段不符合预期`,
    );
    assert.equal(
      tagUrl.decodeTagParam(segment),
      tagUrl.tagSlugOfName(name),
      `标签「${name}」的 URL 段无法可逆还原`,
    );
  }

  // `+` 是表单编码的历史遗留：同一个「空格」，两种写法都要吃下（`tag-url.ts:15-18`）。
  assert.equal(tagUrl.decodeTagParam("vector+db"), "vector db");
  assert.equal(tagUrl.decodeTagParam("vector%20db"), "vector db");
  // 畸形编码不能让整页 500（`tag-url.ts:74-76`）。
  assert.equal(tagUrl.decodeTagParam("%E4%BD"), "%e4%bd");
});

/**
 * 回归守护：`decodeTagParam` 里 `+` → `%20` 必须在 `decodeURIComponent` **之前**。
 *
 * 这是 **task-13 抓出、Lead 在 `lib/tag-url.ts:90-98` 修掉的真实缺陷**。
 * 当时顺序是「先 decode 再替换 `+`」，于是 `c%2B%2B` 先变成 `c++`、
 * 两个真加号被当成空格、`trim()` 又把尾部空格吃掉，最终只剩 `"c"` ——
 * `/tags/c%2B%2B` 会渲染空状态，但真实数据里当时没有含 `+` 的标签，所以线上没炸。
 *
 * 这条用例存在的唯一目的：**以后谁把这两行顺序改回去，这里立刻变红。**
 * 它不看实现，只看输入输出，所以修法可以变，只要语义不变就不会误报。
 */
test("回归：标签名含真加号（C++）经 URL 往返后仍等于自己（task-13 发现、Lead 已修）", () => {
  // 1) 逐层确认，坏在哪一步一眼能看出来，不用再去猜。
  assert.equal(tagUrl.tagSlugOfName("C++"), "c++", "归一化应保留真加号");
  assert.equal(tagUrl.tagHref("C++"), "/tags/c%2B%2B", "`+` 必须编码成 `%2B`，不能留裸 `+`");

  // 2) 核心回归断言：旧实现这里返回 "c"。
  assert.equal(tagUrl.decodeTagParam("c%2B%2B"), "c++", "顺序反了的话这里会退化成 'c'");
  assert.equal(tagUrl.decodeTagParam("a%2Bb"), "a+b", "夹在中间的真加号同样不能被吃");

  // 3) 往返闭环 + 匹配判据，这才是 `/tags/[tag]` 真正依赖的两个函数。
  const segment = tagUrl.tagHref("C++").slice(tagUrl.TAGS_PATH.length + 1);
  assert.equal(
    tagUrl.decodeTagParam(segment),
    tagUrl.tagSlugOfName("C++"),
    "标签页拿到的路由段必须能还原成原标签",
  );
  assert.equal(tagUrl.tagMatches("C++", segment), true, "往返后必须仍匹配自己");

  // 4) 反向保护：真正的空格写法（裸 `+` 与 `%20`）不能被这次修复弄坏 ——
  //    修复的诱惑是把整个 `.replace(/\+/g," ")` 删掉，那样这两种写法就都不认了。
  assert.equal(tagUrl.decodeTagParam("vector+db"), "vector db", "裸 `+` 仍当空格");
  assert.equal(tagUrl.decodeTagParam("vector%20db"), "vector db", "`%20` 仍当空格");
  assert.equal(tagUrl.decodeTagParam("a%2Bb+cd"), "a+b cd", "真加号与空格可以同时出现");

  // 5) 畸形编码不能让整页 500（`tag-url.ts:94-96` 的 catch 分支）。
  assert.equal(tagUrl.decodeTagParam("%E4%BD"), "%e4%bd", "畸形编码退回原串，不抛");
});

/* -------------------------------------------------------------------------- */
/* 四、媒体：图片引用检查扫的是真实列（data->>'cover' 与 body_md）                 */
/* -------------------------------------------------------------------------- */

test("媒体：封面图能被找到，且命中的是真正挂它的那一篇", async () => {
  // 真实数据：`rag-chunking-strategies.md:7` 写了 cover: "/images/rag-pipeline.svg"，
  // 导入时封面上提到 `entries.data.cover`（不是正文），所以这条验的是
  // `findMediaReferences` 的扫描路径 ①。
  const refs = await mediaRefs.findMediaReferences("/images/rag-pipeline.svg");

  assert.ok(refs.length > 0, "封面图必须被找到，否则删除校验会漏放");
  assert.equal(refs[0].kind, "blog", `第一条命中应是 blog（实际 ${refs[0].kind}）`);
  assert.equal(refs[0].slug, "rag-chunking-strategies", `第一条命中应是挂这张封面的文章`);
  assert.equal(refs[0].field, "data.cover", `封面应记成 data.cover（实际 ${refs[0].field}）`);
  assert.ok(refs[0].title.length > 0, "命中项要带标题，删除确认框直接展示它");

  // 另一张真实封面同样要能找到（防止「只对某一张硬编码」）。
  // 这张图**在同一个文件里出现了两次**：`langgraph-rag-workflow.md:7` 的 cover，
  // 以及同文件 `:23` 正文里的 `![LangGraph 检索问答流程](/images/langgraph-flow.svg)`。
  // 所以预期是 2 条、同 slug、不同 field —— 这不是噪音，恰恰是删除确认框
  // 必须能区分「封面」和「正文引用」的原因：作者删了封面但正文还在用，图不能删。
  const other = await mediaRefs.findMediaReferences("/images/langgraph-flow.svg");
  assert.deepEqual(
    other.map((ref) => ref.slug),
    ["langgraph-rag-workflow", "langgraph-rag-workflow"],
    "langgraph-flow.svg 只被 langgraph-rag-workflow 一篇引用（但引用两次）",
  );
  assert.deepEqual(
    other.map((ref) => ref.field).sort(),
    ["body_md", "data.cover"],
    "同一篇的封面引用与正文引用必须分别成条，否则删除确认框会说不出图挂在哪",
  );
});

test("媒体：同一张图被两篇内容引用时返回两条（各自标明命中字段）", async () => {
  // 独立库：这条要插一行内容，不能污染共享库（会改变别的用例的引用计数）。
  const seeded = await createSeededDatabase();
  adminDbModule.setAdminDatabase(seeded.db as never);

  try {
    // 真实数据里 rag-pipeline.svg 已经有 2 条引用（不是 1 条）：
    // ① `blog/rag-chunking-strategies.md:7` 的 cover；
    // ② `projects/rag-knowledge-assistant.md:28` 正文里的 `![检索问答流程](...)`。
    // 前置条件按实测写死，是为了让下面「插一行 → 多一条」的增量断言有意义：
    // 如果这里写成别的数字，后面那条 +1 就可能被别的原因凑对。
    const before = await mediaRefs.findMediaReferences("/images/rag-pipeline.svg");
    assert.equal(before.length, 2, `前置条件：改动前应有 2 条引用（实际 ${before.length}）`);
    assert.deepEqual(
      before.map((ref) => `${ref.kind}/${ref.slug}/${ref.field}`),
      ["blog/rag-chunking-strategies/data.cover", "projects/rag-knowledge-assistant/body_md"],
      "前置条件：真实的两条引用各自挂在封面列与正文列上",
    );

    // 插一条真实形态的日记：正文里用 Markdown 图片语法引用同一张图。
    // 这不是 mock —— 写的是生产同构的 `entries` 行（列名、默认值都由 schema 决定），
    // `findMediaReferences` 读到的是真的 `body_md` 列。
    const db = seeded.db as unknown as {
      insert: (table: unknown) => { values: (value: unknown) => Promise<unknown> };
    };
    await db.insert(entries).values({
      kind: "diary",
      slug: "reuse-cover-demo",
      title: "复用封面的日记",
      summary: "这条只用于验证引用检查能认出第二处引用。",
      body_md: "正文里插一张图：\n\n![示意图](/images/rag-pipeline.svg)\n",
      publish_status: "published",
      display_date: "2026-10-20",
    });

    const after = await mediaRefs.findMediaReferences("/images/rag-pipeline.svg");
    assert.equal(after.length, 3, `三处引用同一张图时应返回 3 条（实际 ${after.length}）`);

    // 排序稳定（先 kind 再 slug），避免「两次运行顺序不同让人以为数据变了」。
    // `findMediaReferences` 的排序见 `references.ts:174-177`。
    assert.deepEqual(
      after.map((ref) => `${ref.kind}/${ref.slug}/${ref.field}`),
      [
        "blog/rag-chunking-strategies/data.cover",
        "diary/reuse-cover-demo/body_md",
        "projects/rag-knowledge-assistant/body_md",
      ],
      "引用列表的排序与命中字段不符合预期",
    );

    // 新插的这篇必须能被查出来，否则「增量」可能来自别的地方
    // （比如上面 2 条其实变成了 3 条里换了一条，数量对但语义错）。
    assert.ok(
      after.some((ref) => ref.slug === "reuse-cover-demo" && ref.title === "复用封面的日记"),
      "新插入的日记应出现在引用列表里，且带标题",
    );
  } finally {
    adminDbModule.setAdminDatabase(shared.db as never);
    await seeded.client.close();
  }
});

test("媒体：没有任何引用的路径返回空数组（删除校验据此放行）", async () => {
  assert.deepEqual(await mediaRefs.findMediaReferences("/images/never-referenced-anywhere.svg"), []);
  // 空串也不能抛错（调用方可能拿到一个空输入）。
  assert.deepEqual(await mediaRefs.findMediaReferences("   "), []);
});

test("媒体：只存在于历史版本快照里的引用也算「还在用」（P5 审计四-2 的回归）", async () => {
  /*
   * 这条守的是审计报告四-2 指出的缺口：`findMediaReferences` 原来只扫
   * `entries` 当前行（`data->>'cover'` 与 `body_md`），漏了 `entry_revisions.snapshot`。
   *
   * 真实事故形态：某篇文章第 1 版正文引用了 `old-diagram.svg`，第 2 版把图换成了
   * `new-diagram.svg`。此时 `entries.body_md` 里已经不含 `old-diagram.svg`，
   * 按旧实现会判定「没人用」，允许删除 —— 但作者只要回滚到 v1，页面立刻破图，
   * 而图在对象存储里已经没了、无法恢复。
   *
   * 用独立库（不能污染共享库：会改变别的用例对 rag-pipeline.svg 的引用计数）。
   */
  const seeded = await createSeededDatabase();
  adminDbModule.setAdminDatabase(seeded.db as never);

  try {
    const db = seeded.db as unknown as {
      insert: (table: unknown) => { values: (value: unknown) => Promise<unknown> };
    };

    // 当前行：正文里**没有**任何图片引用（模拟「图已经换掉/删掉」的状态）。
    await db.insert(entries).values({
      kind: "blog",
      slug: "revision-only-ref",
      title: "只在旧版本里用过图的文章",
      summary: "当前正文已经不再引用 old-diagram.svg。",
      body_md: "现在的正文只有文字，没有任何图片。\n",
      publish_status: "published",
      display_date: "2026-10-21",
      data: { category: "工程实践" },
    });

    const current = await mediaRefs.findMediaReferences("/images/old-diagram.svg");
    assert.deepEqual(
      current,
      [],
      "前置条件：当前行不含这张图，所以只看 entries 时应为空（这正是旧实现的盲区）",
    );

    // 历史版本：v1 的 snapshot 里 body_md 引用着 old-diagram.svg。
    // snapshot 的形状与 `actions.ts` 的 `snapshotOf()` 一致 —— 存的是可回滚的业务字段全集。
    const allEntries = (await (seeded.db as unknown as {
      select: () => { from: (table: unknown) => Promise<{ id: string; slug: string }[]> };
    })
      .select()
      .from(entries)) as { id: string; slug: string }[];
    const target = allEntries.find((row) => row.slug === "revision-only-ref");
    assert.ok(target, "前置条件：刚插入的那一行必须查得到");
    const entryId = target.id;

    await db.insert(entryRevisions).values({
      entry_id: entryId,
      version: 1,
      snapshot: {
        title: "只在旧版本里用过图的文章",
        body_md: "旧版正文：\n\n![旧版示意图](/images/old-diagram.svg)\n",
        data: { category: "工程实践" },
        publish_status: "published",
      },
      change_note: "把旧示意图换掉",
    });

    const afterSnapshot = await mediaRefs.findMediaReferences("/images/old-diagram.svg");
    assert.equal(
      afterSnapshot.length,
      1,
      `历史快照里的引用必须被算进来，否则删除会毁掉回滚能力（实际 ${afterSnapshot.length} 条）`,
    );
    assert.equal(afterSnapshot[0].slug, "revision-only-ref", "命中项要能定位到是哪一篇");
    assert.equal(afterSnapshot[0].kind, "blog", "命中项要带 kind");
    assert.ok(
      afterSnapshot[0].field.startsWith("entry_revisions.snapshot"),
      `命中字段要指明来自历史快照并带版本号（实际 ${afterSnapshot[0].field}）`,
    );
    assert.ok(
      afterSnapshot[0].field.includes("v1"),
      `字段名里要带版本号，删除确认框才能告诉作者「图在 v1 里」`,
    );

    // 反向验证「只来自快照」：`current` 在插入 revision **之前**已经断言为空，
    // 插入之后变 1 —— 增量只可能来自 snapshot，当前行不可能凭空多出引用。
    // 再补一条：同一张图换成不存在的路径必须仍然是空，排除「粗筛把什么都捞进来」。
    assert.deepEqual(
      await mediaRefs.findMediaReferences("/images/definitely-not-anywhere.svg"),
      [],
      "粗筛不能把无关路径也捞进来",
    );
  } finally {
    adminDbModule.setAdminDatabase(shared.db as never);
    await seeded.client.close();
  }
});

/* -------------------------------------------------------------------------- */
/* 五、健康检查：ok / down / degraded 三条分支都用真实的库状态验                   */
/* -------------------------------------------------------------------------- */

test("健康检查：注入可用库时 database=ok，且 HTTP 200", async () => {
  const saved = process.env.DATABASE_URL;
  // `hasDatabaseUrl()` 只认 DATABASE_URL 非空；这里给一个**不会被真正连接**的值 ——
  // `getAdminDb()` 会优先返回注入实例，所以不会去连这个假地址。
  process.env.DATABASE_URL = "postgres://injected:not-used@127.0.0.1:5432/loxander";

  try {
    const report = await health.buildHealthReport();

    assert.equal(report.database, "ok", "注入的 PGlite 能执行 select 1，应报 ok");
    assert.equal(report.ok, true, "ok 分支下顶层 ok 必须为 true");
    assert.equal(health.healthHttpStatus(report), 200, "ok 应配 200");
    // 契约只有四个字段，多一个都算泄露内部信息（方案 §15.2）。
    assert.deepEqual(Object.keys(report).sort(), ["database", "ok", "timestamp", "version"]);
    // timestamp 必须是可解析的 ISO 串（监控按它判「探针有多新」）。
    assert.equal(Number.isNaN(Date.parse(report.timestamp)), false, "timestamp 必须是合法时间");
    // 没注入 commit sha 时应回退成 dev（`health.ts:71-75`）。
    assert.equal(report.version, "dev", "未设置 VERCEL_GIT_COMMIT_SHA / GIT_COMMIT_SHA 时应为 dev");
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

test("健康检查：库执行语句抛错时 database=down，且 HTTP 503", async () => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://injected:not-used@127.0.0.1:5432/loxander";

  // 一个「连上了但一执行就报错」的库：比注入 null 更接近真实故障
  // （权限被收回、库被挂起、连接被中途掐断都是这个形态）。
  // 注意这里**不 mock 业务逻辑** —— 注入点本来就是为这种故障演练留的
  // （`lib/admin/db.ts:41-45 setAdminDatabase`）。
  const brokenDb = {
    execute: async (): Promise<never> => {
      throw new Error("Connection terminated unexpectedly");
    },
  };
  adminDbModule.setAdminDatabase(brokenDb as never);

  try {
    const report = await health.buildHealthReport();

    assert.equal(report.database, "down", "执行语句抛错必须判成 down，不能判成 degraded");
    assert.equal(report.ok, false, "down 的顶层 ok 必须为 false");
    assert.equal(health.healthHttpStatus(report), 503, "down 应配 503");

    // 关键安全断言：错误串里可能带主机名 / 连接串，绝不能进响应体（方案 §15.2）。
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("Connection terminated"), false, "响应体泄露了内部错误");
    assert.equal(serialized.includes("127.0.0.1"), false, "响应体泄露了主机名");
    assert.equal(serialized.includes("postgres://"), false, "响应体泄露了连接串");
  } finally {
    adminDbModule.setAdminDatabase(shared.db as never);
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

test("健康检查：完全没配库时报 degraded 且 HTTP 200（纯静态部署也是健康形态）", async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  // 清掉注入：否则 getAdminDb() 会返回注入库，走不到「没配库」分支。
  adminDbModule.setAdminDatabase(undefined);

  try {
    const report = await health.buildHealthReport();

    // `health.ts:83-87` 的语义边界：没配库是配置状态，不是故障。
    // 若这里报成 down，每一套纯静态部署的监控都会永久红着。
    assert.equal(report.database, "degraded", "没配库应报 degraded 而不是 down");
    assert.equal(report.ok, true, "degraded 仍算健康（ok: true）");
    assert.equal(health.healthHttpStatus(report), 200, "degraded 应配 200");
  } finally {
    adminDbModule.setAdminDatabase(shared.db as never);
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

/* -------------------------------------------------------------------------- */
/* 六、横向一致性：四条链路共用同一份真实数据，计数必须对得上                     */
/* -------------------------------------------------------------------------- */

test("横向一致性：标签聚合、文章列表、搜索结果三者基于同一份真实数据", async () => {
  const posts = await content.getAllPosts();
  const tagCounts = await content.getAllTags();
  const categories = await content.getAllCategories();

  // 1) 标签计数之和 = 所有文章的标签数之和（聚合没有漏行也没有多算）。
  const expectedTagTotal = posts.reduce((sum, post) => sum + post.tags.length, 0);
  const actualTagTotal = tagCounts.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(actualTagTotal, expectedTagTotal, "标签计数之和与文章标签总数不一致");

  // 2) 分类计数之和 = 文章总数（每篇文章恰好一个分类）。
  const categoryTotal = categories.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(categoryTotal, posts.length, "分类计数之和应等于文章总数");

  // 3) 用一个真实标签做交叉验证：标签页筛出的集合必须与搜索结果一致。
  //    searchPosts 走「打分 + 排序」，getPostsByTag 走「过滤 → 保持列表序」，
  //    两者对一个「只出现在标签里」的词的命中集合必须相同。
  const probeTag = tagCounts[0].tag;
  const byTag = await content.getPostsByTag(probeTag);
  const bySearch = await content.searchPosts(probeTag);
  assert.deepEqual(
    bySearch.map((item) => item.slug).sort(),
    byTag.map((item) => item.slug).sort(),
    `标签「${probeTag}」在标签页与搜索页给出的集合必须相同`,
  );
});
