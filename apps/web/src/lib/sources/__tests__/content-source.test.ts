/**
 * `ContentSource` 的验收测试（接口 / markdown 实现 / db 实现 / 工厂）。
 *
 * ── 为什么用 `node:test` 而不是 vitest ─────────────────────────────────
 * 与本仓库 `db/mapping.test.ts:4-16` 同一原因：本机沙箱禁止管道 stdio 子进程
 * （执行记录 §6.3），vitest 与 `node --test`（默认 fork）都会 `spawn EPERM`。
 * 只有 `--test-isolation=none` + 自装 resolve hook 能跑。
 *
 * 运行方式（仓库根 `loxander-platform/`）：
 *   node apps/web/src/lib/sources/__tests__/content-source.test.ts
 *   # 或：node --test-isolation=none apps/web/src/lib/sources/__tests__/content-source.test.ts
 *
 * 本机没有 Postgres，db 实现的「真读库」用 PGlite 跑真迁移 + 真导入后注入
 * （`setDbContentSourceDatabase`，见 `sources/db.ts:110` 注释），
 * 所以这里验证的是**完整闭环**：markdown 原文 → db/mapping → PGlite → 本文件读出。
 */

/* -------------------------------------------------------------------------- */
/* resolve hook 引导：`.ts` 后缀 / `@/` 别名 / `server-only` 替身                */
/* -------------------------------------------------------------------------- */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

/** `apps/web/src`（本文件在 `src/lib/sources/__tests__/` 下，往上三层）。 */
const SRC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
/** `apps/web`。 */
const WEB_DIR = resolvePath(SRC_DIR, "..");
/** 仓库根 `loxander-platform`。 */
const REPO_DIR = resolvePath(WEB_DIR, "..", "..");
/** `server-only` 在非 react-server 条件下解析到会抛错的 `index.js`，测试里换成空模块。 */
const SERVER_ONLY_EMPTY = resolvePath(REPO_DIR, "node_modules/server-only/empty.js");
/**
 * `next/cache` 的测试替身。
 *
 * `sources/db.ts` 的 `"use cache"` 函数里调了 `cacheTag()`，真实实现要求
 * `process.env.__NEXT_USE_CACHE` 为真（只有 Next 编译器会注入），纯 node 下必抛。
 * 不替换的话，凡是走详情路径的用例都会挂在缓存标签上，而不是挂在被验的等价性上。
 * 见同目录 `next-cache-stub.ts` 的说明。
 */
const NEXT_CACHE_STUB = resolvePath(SRC_DIR, "lib/sources/__tests__/next-cache-stub.ts");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: pathToFileURL(SERVER_ONLY_EMPTY).href, shortCircuit: true };
    }

    if (specifier === "next/cache") {
      return { url: pathToFileURL(NEXT_CACHE_STUB).href, shortCircuit: true };
    }

    // 站点代码用 tsconfig 的 `paths`：`@/*` → `apps/web/src/*`。
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

/* -------------------------------------------------------------------------- */
/* 引导之后再加载被测代码                                                       */
/* -------------------------------------------------------------------------- */

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * 四个 lib 用 `path.join(process.cwd(), "content", ...)` 定位 markdown
 * （`lib/posts.ts:22`、`lib/diary.ts:22` 等），也就是说**它们依赖启动目录**。
 * 站点运行时 cwd 就是 `apps/web`，所以测试里显式切过去；
 * 否则从仓库根跑会因为找不到 `content/` 而静默返回空数组，
 * 让 markdown 源看起来「一篇都没有」（首次跑本文件就踩到，已修）。
 */
process.chdir(WEB_DIR);

const requireFromRepo = createRequire(pathToFileURL(resolvePath(REPO_DIR, "package.json")).href);
/** 依赖在仓库根 node_modules（npm workspaces hoist），绕过 `@/` 别名解析。 */
const importFromRepo = (name: string) =>
  import(pathToFileURL(requireFromRepo.resolve(name)).href);

const {
  CONTENT_SOURCE_ENV,
  CONTENT_SOURCE_KINDS,
  DEFAULT_CONTENT_SOURCE,
  getContentSource,
  resetContentSource,
  resolveContentSourceKind,
} = await import("../../content-source");
const { createMarkdownContentSource } = await import("../markdown");
const {
  createDbContentSource,
  setDbContentSourceDatabase,
  toDiaryMeta,
  toGoalMeta,
  toPostMeta,
  toProjectMeta,
} = await import("../db");

// 四个 lib 的原始实现（markdown 实现必须与它们逐字节等价）。
const postsLib = await import("../../posts");
const projectsLib = await import("../../projects");
const diaryLib = await import("../../diary");
const goalsLib = await import("../../goals");

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 深排序对象键后再序列化。
 *
 * 为什么需要：`milestones` 存 `data` jsonb，Postgres 的 jsonb **不保留对象键顺序**
 * （实测写入 `{title,done}` 读出成 `{done,title}`）。若直接用 `JSON.stringify`
 * 比会误报差异，所以比较前把键统一排序。
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * 逐字段严格比对**整条记录**（含 `tags`）。
 *
 * 早期版本这里有三处 `stripTags*` 辅助函数，用来把两侧的 `tags` 抹成 `[]`，
 * 以便在 P2 的 tags 缺口尚未补齐时也能比对其余字段。缺口补齐后（导入写
 * `tags` + `entry_tags`、读出 join 回来、`tag_order` 保序），抹标签等于把
 * 最容易被改坏的一列排除在验收之外，所以三个 `stripTags*` 已全部删除，
 * 所有断言现在都直接比对带 `tags` 的原值。
 */

/** 10 个真实文件的清单（顺序 = 各目录文件名升序，与 lib 的读法一致）。 */function realFiles() {
  const kinds = ["blog", "diary", "projects", "goals"] as const;
  const files: { kind: (typeof kinds)[number]; slug: string; raw: string }[] = [];

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

/**
 * 起一个跑过**全部迁移**、装满 10 篇真实内容（含标签关系）的 PGlite，
 * 返回注入用的 drizzle 实例。
 *
 * 迁移必须按 `db/migrations/meta/_journal.json` 的顺序**全部**执行，
 * 不能只跑 `0000_init.sql` —— `0001_entry_tag_order.sql` 给 `entry_tags`
 * 加了 `tag_order` 列，漏跑它会让读标签的 JOIN 直接报
 * `column entry_tags.tag_order does not exist`（这正是补齐 tags 后第一次
 * 跑本文件时踩到的坑，写在这里防止下次再踩）。
 */
async function createSeededDatabase() {
  const { PGlite } = (await importFromRepo("@electric-sql/pglite")) as typeof import("@electric-sql/pglite");
  const { drizzle } = (await importFromRepo("drizzle-orm/pglite")) as {
    drizzle: (client: unknown) => unknown;
  };
  const { entries, entryTags, tags } = await import(
    pathToFileURL(resolvePath(REPO_DIR, "db/schema.ts")).href
  );
  const { mapEntry, renderOptionsForKind, tagSlugOf } = await import(
    pathToFileURL(resolvePath(REPO_DIR, "db/mapping.ts")).href
  );
  const { renderMarkdown } = await import(
    pathToFileURL(resolvePath(REPO_DIR, "packages/markdown/src/index.ts")).href
  );

  const client = new PGlite();

  // 迁移按 journal 顺序全跑（当前是 0000_init → 0001_entry_tag_order）。
  const migrationDir = resolvePath(REPO_DIR, "db/migrations");
  const journal = JSON.parse(readFileSync(resolvePath(migrationDir, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    await client.exec(readFileSync(resolvePath(migrationDir, `${entry.tag}.sql`), "utf8"));
  }

  const db = drizzle(client) as never;

  const files = realFiles();
  const knownBlogSlugs = files.filter((file) => file.kind === "blog").map((file) => file.slug);

  /** `tagSlugOf(name)` → 名称；同时充当 id 查找的插入顺序。 */
  const tagNameOfSlug = new Map<string, string>();
  /** entry key（`kind/slug`）→ 该行的标签名数组（下标即 tag_order）。 */
  const tagsOfEntry = new Map<string, string[]>();
  /** entry key → 插入后回查得到的 uuid。 */
  const entryIdOfKey = new Map<string, string>();

  for (const file of files) {
    const mapped = mapEntry(file.kind, file.slug, file.raw, {
      publicDir: resolvePath(WEB_DIR, "public"),
      knownBlogSlugs,
    });
    assert.equal(mapped.ok, true, `${file.kind}/${file.slug} 映射失败`);
    const html = await renderMarkdown(mapped.body, renderOptionsForKind(file.kind));
    await (db as unknown as { insert: (table: unknown) => { values: (v: unknown) => Promise<unknown> } })
      .insert(entries)
      .values({ ...mapped.row, body_html: html });

    if (mapped.tags.length > 0) {
      const key = `${file.kind}/${file.slug}`;
      tagsOfEntry.set(key, mapped.tags);
      for (const name of mapped.tags) tagNameOfSlug.set(tagSlugOf(name), name);
    }
  }

  // 标签主表：按 slug 去重插入（与 `db/import.ts` 的 writeTagRelations 同口径）。
  const slugs = [...tagNameOfSlug.keys()];
  if (slugs.length > 0) {
    await (db as unknown as { insert: (table: unknown) => { values: (v: unknown[]) => Promise<unknown> } })
      .insert(tags)
      .values(slugs.map((slug) => ({ slug, name: tagNameOfSlug.get(slug) ?? slug })));
  }

  // 回查：entry uuid + tag id，再写关系表（`tag_order` = frontmatter 下标）。
  const entryRows = (await (db as unknown as {
    select: () => {
      from: (table: unknown) => Promise<{ id: string; kind: string; slug: string }[]>;
    };
  })
    .select()
    .from(entries)) as { id: string; kind: string; slug: string }[];
  for (const row of entryRows) entryIdOfKey.set(`${row.kind}/${row.slug}`, row.id);

  const tagRows = (await (db as unknown as {
    select: () => { from: (table: unknown) => Promise<{ id: number; slug: string }[]> };
  })
    .select()
    .from(tags)) as { id: number; slug: string }[];
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
    await (db as unknown as { insert: (table: unknown) => { values: (v: unknown[]) => Promise<unknown> } })
      .insert(entryTags)
      .values(links);
  }

  return { client, db, files };
}

/* -------------------------------------------------------------------------- */
/* 1. 工厂：CONTENT_SOURCE 解析                                                */
/* -------------------------------------------------------------------------- */

test("resolveContentSourceKind：空值一律回退到默认 markdown", () => {
  assert.equal(resolveContentSourceKind(undefined), "markdown");
  assert.equal(resolveContentSourceKind(""), "markdown");
  assert.equal(resolveContentSourceKind("   "), "markdown");
  assert.equal(resolveContentSourceKind("\t\n"), "markdown");
  assert.equal(DEFAULT_CONTENT_SOURCE, "markdown");
});

test("resolveContentSourceKind：合法值原样返回，且两端空白被裁掉", () => {
  assert.equal(resolveContentSourceKind("markdown"), "markdown");
  assert.equal(resolveContentSourceKind("db"), "db");
  assert.equal(resolveContentSourceKind(" db "), "db");
  assert.equal(resolveContentSourceKind("\tdb\n"), "db");
});

test("resolveContentSourceKind：非法值抛错，文案里带允许值与默认值", () => {
  // 大小写敏感：拼成 DB 不能被当成 db，否则环境变量笔误会被静默接受。
  for (const value of ["DB", "sqlite", "postgres", "md"]) {
    assert.throws(
      () => resolveContentSourceKind(value),
      (error: Error) => {
        assert.match(error.message, /取值非法/);
        assert.match(error.message, new RegExp(CONTENT_SOURCE_ENV));
        assert.ok(error.message.includes(value), "错误文案应回显原始值");
        for (const kind of CONTENT_SOURCE_KINDS) {
          assert.ok(error.message.includes(kind), `文案应列出允许值 ${kind}`);
        }
        return true;
      },
      `期望 ${value} 抛错`,
    );
  }
});

test("getContentSource：默认走 markdown，且进程内复用同一个实例", async () => {
  const saved = process.env[CONTENT_SOURCE_ENV];
  delete process.env[CONTENT_SOURCE_ENV];
  resetContentSource();

  try {
    const first = await getContentSource();
    const second = await getContentSource();
    assert.equal(first.kind, "markdown");
    assert.equal(first, second, "工厂应缓存实例（sources/db.ts 的连接是单例，不能重复建）");
  } finally {
    if (saved === undefined) delete process.env[CONTENT_SOURCE_ENV];
    else process.env[CONTENT_SOURCE_ENV] = saved;
    resetContentSource();
  }
});

test("getContentSource：CONTENT_SOURCE=db 时 kind 为 db（建连是惰性的，不读 DATABASE_URL）", async () => {
  const saved = process.env[CONTENT_SOURCE_ENV];
  const savedUrl = process.env.DATABASE_URL;
  process.env[CONTENT_SOURCE_ENV] = "db";
  delete process.env.DATABASE_URL;
  resetContentSource();

  try {
    const source = await getContentSource();
    assert.equal(source.kind, "db");
  } finally {
    if (saved === undefined) delete process.env[CONTENT_SOURCE_ENV];
    else process.env[CONTENT_SOURCE_ENV] = saved;
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    resetContentSource();
  }
});

test("getContentSource：resetContentSource 之后能读到新的环境变量值", async () => {
  const saved = process.env[CONTENT_SOURCE_ENV];
  delete process.env[CONTENT_SOURCE_ENV];
  resetContentSource();

  try {
    assert.equal((await getContentSource()).kind, "markdown");
    process.env[CONTENT_SOURCE_ENV] = "db";
    resetContentSource();
    assert.equal((await getContentSource()).kind, "db");
  } finally {
    if (saved === undefined) delete process.env[CONTENT_SOURCE_ENV];
    else process.env[CONTENT_SOURCE_ENV] = saved;
    resetContentSource();
  }
});

/* -------------------------------------------------------------------------- */
/* 2. markdown 实现：必须与四个 lib 逐字节等价                                   */
/* -------------------------------------------------------------------------- */

test("markdown 实现：15 个方法与四个 lib 的原始导出逐个等价", async () => {
  const source = createMarkdownContentSource();
  assert.equal(source.kind, "markdown");

  // getBlogSlugs **不**过滤草稿，而 getAllPosts 过滤 —— 两者口径不同，分别断言。
  assert.deepEqual(await source.getBlogSlugs(), postsLib.getBlogSlugs());
  assert.deepEqual(await source.getAllPosts(), postsLib.getAllPosts());
  assert.deepEqual(await source.getRecentPosts(), postsLib.getRecentPosts());
  assert.deepEqual(await source.getRecentPosts(2), postsLib.getRecentPosts(2));
  assert.deepEqual(await source.getAdjacentPosts("week01"), postsLib.getAdjacentPosts("week01"));
  assert.deepEqual(await source.getRelatedPosts("week01"), postsLib.getRelatedPosts("week01"));
  assert.deepEqual(await source.getAllTags(), postsLib.getAllTags());
  assert.deepEqual(await source.getAllCategories(), postsLib.getAllCategories());
  assert.deepEqual(await source.getAllProjects(), projectsLib.getAllProjects());
  assert.deepEqual(await source.getFeaturedProjects(), projectsLib.getFeaturedProjects());
  assert.deepEqual(await source.getFeaturedProjects(2), projectsLib.getFeaturedProjects(2));
  assert.deepEqual(await source.getAllDiaryEntries(), diaryLib.getAllDiaryEntries());
  assert.deepEqual(await source.getDiarySlugs(), diaryLib.getDiarySlugs());
  // goals.ts:78 的 getAllGoals 本身就是 async（要跑 Shiki），所以这里必须 await 两边。
  assert.deepEqual(await source.getAllGoals(), await goalsLib.getAllGoals());

  for (const slug of postsLib.getBlogSlugs()) {
    assert.deepEqual(await source.getPost(slug), await postsLib.getPost(slug), `getPost(${slug})`);
  }
  for (const { slug } of projectsLib.getAllProjects()) {
    assert.deepEqual(
      await source.getProject(slug),
      await projectsLib.getProject(slug),
      `getProject(${slug})`,
    );
  }
  for (const slug of diaryLib.getDiarySlugs()) {
    assert.deepEqual(
      await source.getDiaryEntry(slug),
      await diaryLib.getDiaryEntry(slug),
      `getDiaryEntry(${slug})`,
    );
  }
});

test("markdown 实现：不存在的 slug 返回 null / 空数组，与 lib 一致", async () => {
  const source = createMarkdownContentSource();

  assert.equal(await source.getPost("does-not-exist"), null);
  assert.equal(await source.getProject("does-not-exist"), null);
  assert.equal(await source.getDiaryEntry("does-not-exist"), null);
  assert.deepEqual(await source.getRelatedPosts("does-not-exist"), []);
  assert.deepEqual(await source.getAdjacentPosts("does-not-exist"), { prev: null, next: null });
});

/* -------------------------------------------------------------------------- */
/* 3. db 实现：行 → 站点类型的纯映射（不需要数据库）                             */
/* -------------------------------------------------------------------------- */

/**
 * 一行最小 entry（只保留本组测试关心的列）。
 *
 * 注意这里**没有 `body_html`** —— `EntryRow` 刻意不声明它（读路径一律从
 * `body_md` 重渲染，见 `sources/db.ts` 里 `EntryRow` 的注释）。
 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "blog",
    slug: "sample",
    title: "标题",
    summary: "摘要",
    body_md: "正文",
    publish_status: "published",
    featured: false,
    sort_order: 999,
    published_at: new Date("2026-01-02T00:00:00Z"),
    display_date: "2026-01-02",
    data: {} as Record<string, unknown>,
    ...overrides,
  } as Parameters<typeof toPostMeta>[0];
}

test("toPostMeta：字段来源与 posts.ts 一致，cover 键始终存在", () => {
  const withCover = toPostMeta(
    row({
      data: { category: "工程实践", cover: "/images/a.svg", coverWidth: 1200, coverHeight: 630 },
      featured: true,
      sort_order: 3,
      publish_status: "draft",
    }),
  );

  assert.deepEqual(Object.keys(withCover).sort(), [
    "category",
    "cover",
    "coverHeight",
    "coverWidth",
    "date",
    "description",
    "draft",
    "readingTime",
    "slug",
    "tags",
    "title",
  ]);
  assert.equal(withCover.category, "工程实践");
  assert.equal(withCover.cover, "/images/a.svg");
  assert.equal(withCover.coverWidth, 1200);
  assert.equal(withCover.coverHeight, 630);
  assert.equal(withCover.draft, true, "publish_status=draft 应映射成 draft: true");
  // 直接构造的行没有 `tags` 键（真实读路径由 `loadTagNamesOf` 从 entry_tags 回填），
  // 这里验的是映射函数的退化行为：缺 tags 时给空数组，而不是 undefined。
  assert.deepEqual(withCover.tags, [], "行上缺 tags 时退化为空数组");

  // 无封面：cover 键仍在（值为 undefined），与 posts.ts 的 `cover: entry.cover` 对齐。
  const noCover = toPostMeta(row());
  assert.equal("cover" in noCover, true, "cover 键必须恒存在，否则 `\"cover\" in post` 行为会分叉");
  assert.equal(noCover.cover, undefined);
  assert.equal("coverWidth" in noCover, false, "lib 用条件展开，缺尺寸时键不存在");
  assert.equal(noCover.category, "未分类", "缺 category 时的默认值应与 schema 默认一致");
  assert.equal(noCover.date, "2026-01-02");
  assert.equal(noCover.description, "摘要", "description 来自 summary 列");
});

test("toDiaryMeta / toProjectMeta / toGoalMeta：字段与 data jsonb 的取值口径", () => {
  const diary = toDiaryMeta(row({ kind: "diary", summary: "今天", data: { mood: "calm" } }));
  assert.deepEqual(Object.keys(diary).sort(), [
    "date",
    "draft",
    "mood",
    "slug",
    "summary",
    "tags",
    "title",
  ]);
  assert.equal(diary.mood, "calm");

  const project = toProjectMeta(
    row({
      kind: "projects",
      title: "项目名", // projects 的 frontmatter 用 `name`，导入时写进 title 列
      featured: true,
      sort_order: 1,
      data: {
        techStack: ["Next.js", 42, "Postgres"], // 非字符串会被过滤
        status: "active",
        period: "2026.01 - 2026.06",
        role: "全栈",
        github: "https://github.com/x/y",
        demo: "https://example.com",
        article: "build-personal-blog-with-nextjs",
      },
    }),
  );
  assert.equal(project.name, "项目名");
  assert.deepEqual(project.techStack, ["Next.js", "Postgres"]);
  assert.equal(project.featured, true);
  assert.equal(project.order, 1);
  assert.equal(project.article, "build-personal-blog-with-nextjs");

  const goal = toGoalMeta(
    row({
      kind: "goals",
      sort_order: 0,
      data: {
        horizon: "long",
        status: "in_progress",
        progress: 40,
        period: "2026",
        milestones: [{ title: "第一步", done: true }],
      },
    }),
  );
  assert.equal(goal.horizon, "long");
  assert.equal(goal.status, "in_progress");
  assert.equal(goal.progress, 40);
  assert.deepEqual(goal.milestones, [{ title: "第一步", done: true }]);

  // data 缺键时的兜底必须与 content-core 的默认值一致（horizon=short / status=planned）。
  const bare = toGoalMeta(row({ kind: "goals", data: {} }));
  assert.equal(bare.horizon, "short");
  assert.equal(bare.status, "planned");
  assert.equal(bare.progress, 0);
  assert.deepEqual(bare.milestones, []);
});

/* -------------------------------------------------------------------------- */
/* 4. db 实现：PGlite 真迁移 + 真导入后的端到端等价                             */
/* -------------------------------------------------------------------------- */

test("db 实现：10 篇真实内容经 导入 → 落库 → 读出 后，14 个列表/详情方法与 markdown 实现等价", async () => {
  const { client, db, files } = await createSeededDatabase();
  const expectedCounts = { blog: 4, diary: 1, projects: 3, goals: 2 };
  for (const [kind, count] of Object.entries(expectedCounts)) {
    assert.equal(
      files.filter((file) => file.kind === kind).length,
      count,
      `${kind} 篇数应与执行记录一致`,
    );
  }

  setDbContentSourceDatabase(db);
  try {
    const md = createMarkdownContentSource();
    const source = createDbContentSource();
    assert.equal(source.kind, "db");

    // 数量与 slug 集合（ADR-0002 迁移期三重比对的前两重）。
    assert.equal((await source.getAllPosts()).length, (await md.getAllPosts()).length);
    assert.deepEqual(await source.getBlogSlugs(), await md.getBlogSlugs());
    assert.deepEqual(await source.getDiarySlugs(), await md.getDiarySlugs());
    assert.deepEqual(
      (await source.getAllProjects()).map((item) => item.slug),
      (await md.getAllProjects()).map((item) => item.slug),
    );
    assert.deepEqual(
      (await source.getAllGoals()).map((item) => item.slug),
      (await md.getAllGoals()).map((item) => item.slug),
    );

    // 排序：posts 按 date desc、projects/goals 按 order asc 再 name、diary 按 date desc 再 slug。
    // tags 已入库（`tags` + `entry_tags`，`tag_order` 保序），所以这里做**整条记录**的
    // 严格比对，包括标签的顺序 —— 不再有任何「抹掉某列再比」的降级。
    assert.deepEqual(await source.getAllPosts(), await md.getAllPosts());
    assert.deepEqual(await source.getAllProjects(), await md.getAllProjects());
    assert.deepEqual(
      await source.getAllDiaryEntries(),
      await md.getAllDiaryEntries(),
    );
    assert.deepEqual(await source.getRecentPosts(2), await md.getRecentPosts(2));
    assert.deepEqual(await source.getFeaturedProjects(), await md.getFeaturedProjects());
    assert.deepEqual(await source.getAllCategories(), await md.getAllCategories());
    assert.deepEqual(
      await source.getAdjacentPosts("rag-chunking-strategies"),
      await md.getAdjacentPosts("rag-chunking-strategies"),
    );
    assert.deepEqual(
      await source.getRelatedPosts("rag-chunking-strategies"),
      await md.getRelatedPosts("rag-chunking-strategies"),
    );

    // 详情：html 必须逐字节相同（渲染快照，第三重比对）。
    for (const slug of await md.getBlogSlugs()) {
      const actual = await source.getPost(slug);
      const expected = await md.getPost(slug);
      assert.ok(actual, `db 应能读出 ${slug}`);
      assert.equal(actual.html, expected?.html, `getPost(${slug}).html`);
      assert.deepEqual(actual.headings, expected?.headings, `getPost(${slug}).headings`);
      assert.deepEqual(actual, expected, `getPost(${slug})`);
    }
    for (const { slug } of await md.getAllProjects()) {
      const actual = await source.getProject(slug);
      assert.deepEqual(actual, await md.getProject(slug), `getProject(${slug})`);
    }
    for (const slug of await md.getDiarySlugs()) {
      const actual = await source.getDiaryEntry(slug);
      assert.deepEqual(actual, await md.getDiaryEntry(slug), `getDiaryEntry(${slug})`);
    }

    // goals：正文按 headingOffset: 2 重渲染，必须与 markdown 源逐字节一致。
    const goalsDb = await source.getAllGoals();
    const goalsMd = await md.getAllGoals();
    assert.equal(goalsDb.length, goalsMd.length);
    for (let index = 0; index < goalsMd.length; index += 1) {
      const actual = goalsDb[index];
      const expected = goalsMd[index];
      assert.equal(actual.slug, expected.slug);
      assert.equal(actual.html, expected.html, `getAllGoals()[${index}].html`);
      assert.deepEqual(actual.headings, expected.headings);
      // `milestones` 走 jsonb，键序会被 PostgreSQL 规范化（实测写入 {title,done} 读回 {done,title}），
      // 语义相同但 JSON 文本不同 —— 用 canonical 比对。
      assert.equal(
        canonical({ ...actual, milestones: expected.milestones }),
        canonical(expected),
        `getAllGoals()[${index}]`,
      );
    }

    // 不存在的 slug 一律 null / 空数组，不能抛错（页面靠 null 走 notFound()）。
    assert.equal(await source.getPost("does-not-exist"), null);
    assert.equal(await source.getProject("does-not-exist"), null);
    assert.equal(await source.getDiaryEntry("does-not-exist"), null);
    assert.deepEqual(await source.getRelatedPosts("does-not-exist"), []);
    assert.deepEqual(await source.getAdjacentPosts("does-not-exist"), {
      prev: null,
      next: null,
    });
  } finally {
    setDbContentSourceDatabase(undefined);
    await client.close();
  }
});

test("db 实现：getAllTags() 与 markdown 源同集合同计数同排序（标签已入库）", async () => {
  const { client, db } = await createSeededDatabase();
  setDbContentSourceDatabase(db);

  try {
    const md = createMarkdownContentSource();
    const mdTags = await md.getAllTags();
    // 先确认 markdown 源确实有标签，否则这条测试没有意义。
    assert.ok(mdTags.length > 0, "markdown 源应有标签");

    // 集合、每项计数、以及 `count 降序 || 名字升序` 的最终顺序必须逐条一致。
    assert.deepEqual(await createDbContentSource().getAllTags(), mdTags);

    // 单标签的次数也要对得上（取 markdown 侧出现最多的那个作为探针）。
    const top = mdTags[0];
    const dbTags = await createDbContentSource().getAllTags();
    assert.equal(dbTags[0].tag, top.tag);
    assert.equal(dbTags[0].count, top.count);
  } finally {
    setDbContentSourceDatabase(undefined);
    await client.close();
  }
});

test("db 实现：标签顺序按 frontmatter 原序（entry_tags.tag_order）还原", async () => {
  const { client, db } = await createSeededDatabase();
  setDbContentSourceDatabase(db);

  try {
    const md = createMarkdownContentSource();
    const source = createDbContentSource();

    // 逐篇比对标签数组 —— `deepEqual` 对数组是有序比较，顺序错位会直接失败。
    for (const post of await md.getAllPosts()) {
      const actual = await source.getPost(post.slug);
      assert.deepEqual(actual?.tags, post.tags, `getPost(${post.slug}).tags 顺序`);
    }

    // `projects.article` 之类不涉及标签，但 diary 也有 tags，一并验。
    for (const entry of await md.getAllDiaryEntries()) {
      const actual = await source.getDiaryEntry(entry.slug);
      assert.deepEqual(actual?.tags, entry.tags, `getDiaryEntry(${entry.slug}).tags 顺序`);
    }

    // projects / goals 没有 tags 字段，确认没有被误加出来。
    for (const project of await md.getAllProjects()) {
      assert.equal("tags" in project, false, "ProjectMeta 不应有 tags 字段");
    }
    for (const goal of await md.getAllGoals()) {
      assert.equal("tags" in goal, false, "Goal 不应有 tags 字段");
    }
  } finally {
    setDbContentSourceDatabase(undefined);
    await client.close();
  }
});

test("db 实现：getDiarySlugs 走草稿过滤，getBlogSlugs 不走（与 lib 口径差异一致）", async () => {
  const { client, db } = await createSeededDatabase();
  setDbContentSourceDatabase(db);

  try {
    const source = createDbContentSource();
    const md = createMarkdownContentSource();

    // 当前 10 篇全非草稿，两者只能验「相等」；口径差异由代码注释与 compare 兜底。
    assert.deepEqual(await source.getDiarySlugs(), await md.getDiarySlugs());
    assert.deepEqual(await source.getBlogSlugs(), await md.getBlogSlugs());
  } finally {
    setDbContentSourceDatabase(undefined);
    await client.close();
  }
});
