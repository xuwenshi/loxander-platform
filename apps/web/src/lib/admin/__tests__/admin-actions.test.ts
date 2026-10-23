/**
 * P4 后台写路径的离线验收（不需要 Next 起服务，不需要真库）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 * P4 的全部风险集中在 `lib/admin/actions.ts` 的**写路径**上：七个 Server Action
 * 每一个都要自己走完方案 §8.4 的七道关（登录 → 白名单 → 参数校验 → 字段权限
 * → 乐观锁 → 事务内写入与审计 → 缓存失效）。这些逻辑没有任何一行会被 `tsc` 抓到
 * 问题：版本号算错、审计漏写、标签没重写、缓存标签少失效一个，全都编译通过、
 * 页面也照常渲染，只有真的写一次库才看得出来。
 *
 * 而本机沙箱禁止子进程（`spawn EPERM`，见执行记录 §7.3 陷阱 3），`next build` /
 * `next dev` 都跑不起来，Playwright 更无从谈起。所以这里退到「直接调 Server Action
 * 函数 + PGlite 内存库」，把七道关逐条断言。
 *
 * ── 三个必须打桩的东西 ────────────────────────────────────────────────
 * 1. `server-only`  → 空模块（真实包在非 RSC 环境会直接抛错）。
 * 2. `next/cache`   → `next-cache-admin-stub.ts`（记录 `updateTag` / `revalidatePath`
 *                     的调用，因为「写完有没有把该失效的标签失效掉」是第 7 道关的
 *                     唯一可观测证据）。
 * 3. `../auth`      → `auth-stub.ts`（真实 `requireAdmin()` 会走 `auth()` →
 *                     `next/headers` 读 cookie，纯 node 里没有请求上下文，必抛）。
 *                     注意白名单逻辑**没有**在替身里复制：那属于 `lib/auth.ts`，
 *                     改坏了应该让 `lib/auth.ts` 自己的测试红，而不是这里。
 *
 * 另外 `next` 包没有 `exports` 字段，`next/navigation` 之类在纯 node 下解析不到，
 * 必须在 resolve 钩子里补 `.js` 后缀（这条是踩过的坑，写在下面）。
 *
 * 跑法：`node --test-isolation=none apps/web/src/lib/admin/__tests__/admin-actions.test.ts`
 */

import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `apps/web/src`（本文件在 `src/lib/admin/__tests__/` 下，往上三层）。 */
const SRC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
/** `apps/web`。 */
const WEB_DIR = resolvePath(SRC_DIR, "..");
/** 仓库根 `loxander-platform`。 */
const REPO_DIR = resolvePath(WEB_DIR, "..", "..");

const SERVER_ONLY_EMPTY = resolvePath(REPO_DIR, "node_modules/server-only/empty.js");
const ADMIN_CACHE_STUB = resolvePath(SRC_DIR, "lib/admin/__tests__/next-cache-admin-stub.ts");
const AUTH_STUB = resolvePath(SRC_DIR, "lib/admin/__tests__/auth-stub.ts");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: pathToFileURL(SERVER_ONLY_EMPTY).href, shortCircuit: true };
    }
    if (specifier === "next/cache") {
      return { url: pathToFileURL(ADMIN_CACHE_STUB).href, shortCircuit: true };
    }

    // `lib/admin/*` 里的 `../auth` 与任何地方写的 `@/lib/auth` 一律换成替身。
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : "";
    const fromAdminDir = parent.includes(`${resolvePath(SRC_DIR, "lib/admin")}`);
    if ((specifier === "../auth" && fromAdminDir) || specifier === "@/lib/auth") {
      return { url: pathToFileURL(AUTH_STUB).href, shortCircuit: true };
    }

    // `next` 没有 exports 字段，`next/server`、`next/navigation` 在纯 node 下
    // 会报 `Cannot find module ...\next\server`。补 `.js` 即可（四个文件都真实存在）。
    if (specifier.startsWith("next/")) {
      const candidate = resolvePath(REPO_DIR, "node_modules", specifier + ".js");
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
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
      const parentFile = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
      const bare = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
      const target = resolvePath(dirname(parentFile), bare);
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(target + ext)) {
          return { url: pathToFileURL(target + ext).href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
});

// `db/mapping.ts` 用 `path.join(process.cwd(), ...)` 找内容目录与 public，
// 站点的运行时 cwd 就是 `apps/web`，测试里必须切过去。
process.chdir(WEB_DIR);

import { test } from "node:test";
import assert from "node:assert/strict";

const requireFromRepo = createRequire(pathToFileURL(resolvePath(REPO_DIR, "package.json")).href);
/** 依赖都在仓库根 node_modules（npm workspaces hoist），这里绕过 `@/` 别名直接解析。 */
const importFromRepo = (name: string) =>
  import(pathToFileURL(requireFromRepo.resolve(name)).href) as Promise<never>;

/* -------------------------------------------------------------------------- */
/* 引导之后再加载被测代码                                                       */
/* -------------------------------------------------------------------------- */

const cacheStub = (await import(
  pathToFileURL(ADMIN_CACHE_STUB).href
)) as typeof import("./next-cache-admin-stub");
const authStub = (await import(pathToFileURL(AUTH_STUB).href)) as typeof import("./auth-stub");
const schema = (await import(pathToFileURL(resolvePath(REPO_DIR, "db/schema.ts")).href)) as never;
const actions = (await import(
  pathToFileURL(resolvePath(SRC_DIR, "lib/admin/actions.ts")).href
)) as typeof import("../actions");
const adminDb = (await import(
  pathToFileURL(resolvePath(SRC_DIR, "lib/admin/db.ts")).href
)) as typeof import("../db");
const adminEntries = (await import(
  pathToFileURL(resolvePath(SRC_DIR, "lib/admin/entries.ts")).href
)) as typeof import("../entries");
const validation = (await import(
  pathToFileURL(resolvePath(SRC_DIR, "lib/admin/validation.ts")).href
)) as typeof import("../validation");
const preview = (await import(
  pathToFileURL(resolvePath(SRC_DIR, "lib/admin/preview.ts")).href
)) as typeof import("../preview");

const { entries, entryRevisions, auditLogs, entryTags, tags, users } = schema as unknown as {
  entries: never;
  entryRevisions: never;
  auditLogs: never;
  entryTags: never;
  tags: never;
  users: never;
};

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 起一个跑过**全部迁移**的 PGlite，并把 drizzle 实例注入给后台读路径。
 *
 * 迁移必须按 `db/migrations/meta/_journal.json` 的顺序全部执行，不能只跑
 * `0000_init.sql` —— 漏掉 `0001_entry_tag_order.sql` 会让读标签的 JOIN 报
 * `column entry_tags.tag_order does not exist`（P3 的测试踩过同一个坑）。
 *
 * 注入点是 `setAdminDatabase()`：后台刻意要求「必须连真库」，但那条约束只针对
 * 生产；测试靠注入绕过 DATABASE_URL，这样连外网也不需要。
 */
async function createAdminDatabase() {
  const { PGlite } = await importFromRepo("@electric-sql/pglite");
  const { drizzle } = await importFromRepo("drizzle-orm/pglite");

  const client = new (PGlite as unknown as new () => {
    exec: (sql: string) => Promise<unknown>;
    close: () => Promise<void>;
  })();

  const migrationDir = resolvePath(REPO_DIR, "db/migrations");
  const journal = JSON.parse(readFileSync(resolvePath(migrationDir, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const migration of journal.entries) {
    await client.exec(readFileSync(resolvePath(migrationDir, `${migration.tag}.sql`), "utf8"));
  }

  const db = (drizzle as unknown as (client: unknown, options: unknown) => unknown)(client, {
    schema,
  }) as unknown as {
    insert: (table: unknown) => { values: (row: unknown) => Promise<unknown> };
  };

  // `entries.created_by` / `audit_logs.actor_id` 都有指向 `users.id` 的外键
  // （`ON DELETE SET NULL`），所以写库前必须先有这条用户记录，否则每个
  // action 都会挂在 `entries_created_by_users_id_fk` 上。
  // 真实运行时这行由 Auth.js 的 adapter 在首次登录时创建。
  await db.insert(users).values({
    id: authStub.ADMIN_USER_ID,
    name: "测试管理员",
    email: "admin@example.com",
    github_login: "tester",
  });

  adminDb.setAdminDatabase(db as never);

  return { client, db: db as never, migrationCount: journal.entries.length };
}

/** 一张合法的 blog 表单（创建草稿用）。 */
function blogForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("kind", "blog");
  form.set("slug", "hello-platform");
  form.set("title", "平台化第一篇");
  form.set("summary", "这是摘要");
  form.set("bodyMd", "# 小标题\n\n正文一段。\n\n## 二级\n\n又一段。");
  form.set("displayDate", "2026-03-04");
  form.set("category", "工程实践");
  form.set("tags", "TypeScript, 前端, TypeScript");
  form.set("cover", "");
  form.set("expectedVersion", "1");

  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return form;
}

/** 取某个 action 抛出的 `redirect()` 信号（Next 用异常实现跳转）。 */
async function catchRedirect(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest;
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* 1. 模块可加载（打桩是否够用）                                                */
/* -------------------------------------------------------------------------- */

test("P4 后台模块在纯 node 下可加载（server-only / next/cache / next/* 已打桩）", () => {
  assert.equal(typeof actions.createEntryAction, "function");
  assert.equal(typeof actions.saveEntryAction, "function");
  assert.equal(typeof actions.publishEntryAction, "function");
  assert.equal(typeof actions.restoreRevisionAction, "function");
  assert.equal(typeof actions.bulkArchiveAction, "function");
  assert.equal(typeof validation.validateEntryForm, "function");
  assert.equal(typeof preview.sanitizeHtml, "function");
  assert.equal(typeof adminEntries.listEntries, "function");
});

/* -------------------------------------------------------------------------- */
/* 2. 第三道关：表单校验（不碰库）                                              */
/* -------------------------------------------------------------------------- */

test("表单校验：合法 blog 表单通过，标签去重且保序", () => {
  const result = validation.validateEntryForm(blogForm());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.base.slug, "hello-platform");
  assert.equal(result.title, "平台化第一篇");
  // normalizeTagInput 去重保序：下标即 entry_tags.tag_order。
  assert.deepEqual(result.tags, ["TypeScript", "前端"]);
  assert.equal(result.displayDate, "2026-03-04");
  assert.equal(result.isDraft, false);
});

test("表单校验：空标题被拦下，错误落到 title 字段", () => {
  const result = validation.validateEntryForm(blogForm({ title: "   " }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.fieldErrors.title, "应当给出 title 字段错误");
});

test("表单校验：非法 slug 被拦下", () => {
  const result = validation.validateEntryForm(blogForm({ slug: "带中文的 slug" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.fieldErrors.slug, "应当给出 slug 字段错误");
});

test("表单校验：空正文被拦下（第四道关：不许存空内容）", () => {
  const result = validation.validateEntryForm(blogForm({ bodyMd: "   " }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.fieldErrors.bodyMd, "应当给出 bodyMd 字段错误");
});

/* -------------------------------------------------------------------------- */
/* 3. 预览净化（方案 §13.2：禁止脚本 / 事件属性 / 危险 URL）                     */
/* -------------------------------------------------------------------------- */

test("预览净化：script、onerror、javascript: 全部被剥掉", () => {
  const dirty =
    '<p onclick="alert(1)">文字</p><script>alert(2)</script>' +
    '<img src="x" onerror="alert(3)"><a href="javascript:alert(4)">链接</a>';
  const clean = preview.sanitizeHtml(dirty);

  assert.equal(/<script/i.test(clean), false, "script 必须被删除");
  assert.equal(/onerror/i.test(clean), false, "onerror 必须被删除");
  assert.equal(/onclick/i.test(clean), false, "onclick 必须被删除");
  assert.equal(/javascript:/i.test(clean), false, "javascript: 协议必须被删除");
  assert.ok(clean.includes("文字"), "正常文本要保留");
});

test("预览净化：Shiki 的 class 与 style 被放行（否则代码高亮全丢）", () => {
  // 属性名必须与 `@loxander/markdown` 的真实产物一致：`rehypeCodeBlockLanguage`
  // 写的是 **kebab-case 的 `data-language`**（见 `packages/markdown/src/pipeline.ts:90`），
  // 不是 `dataLanguage`。schema 里写 `dataLanguage` 是因为 hast-util-sanitize
  // 会按 property 名比对，输出时再由 rehype-stringify 序列化成 `data-language`。
  const highlighted =
    '<div class="code-block" data-language="ts"><pre class="shiki github-light" style="background-color:#fff">' +
    '<code><span class="line"><span style="color:#0550ae">const</span> a = 1</span></code></pre></div>';
  const clean = preview.sanitizeHtml(highlighted);

  assert.ok(clean.includes("shiki"), "shiki class 必须保留");
  assert.ok(clean.includes("code-block"), "code-block class 必须保留");
  assert.ok(clean.includes("data-language"), "data-language 必须保留");
  assert.ok(clean.includes("background-color"), "内联 style 必须保留");
});

/* -------------------------------------------------------------------------- */
/* 4. 创建草稿（第五、六、七道关：事务 + 审计 + 缓存失效）                       */
/* -------------------------------------------------------------------------- */

test("createEntryAction：落 draft、写版本快照、写审计、写标签、失效三个缓存标签", async () => {
  await createAdminDatabase();
  cacheStub.resetCacheCalls();

  const digest = await catchRedirect(() => actions.createEntryAction(blogForm()));
  assert.ok(digest && digest.includes("/admin/content/blog/hello-platform"), "创建后应跳转到编辑页");

  const listed = await (adminEntries as never as {
    listEntries: (options: unknown) => Promise<{ rows: { id: string; publishStatus: string; version: number }[]; total: number }>;
  }).listEntries({});
  assert.equal(listed.total, 1);
  const created = listed.rows[0];
  assert.equal(created.publishStatus, "draft", "新建一律草稿，发布是独立流程");
  assert.equal(created.version, 1);

  const detail = await (adminEntries as never as {
    getEntryDetail: (kind: string, slug: string) => Promise<{ bodyMd: string } | null>;
  }).getEntryDetail("blog", "hello-platform");
  assert.ok(detail, "创建后应当能查到详情");
  assert.ok(detail!.bodyMd.includes("正文一段。"), "body_md 必须原样入库");

  // `EntryDetailRow` 故意不含 `body_html`（后台一律从 body_md 重渲染，避免
  // 「列里的 HTML 是旧的」这种不一致），所以这里直接查库确认写入时渲染过。
  const rawDb = (await adminDb.getAdminDb()) as never as {
    select: () => { from: (table: unknown) => Promise<{ body_html: string | null }[]> };
  };
  const [raw] = await rawDb.select().from(entries);
  assert.ok(raw.body_html && raw.body_html.length > 0, "body_html 必须在写入时渲染好");
  assert.ok(raw.body_html!.includes("<h1"), "标题应当被渲染成 h1");

  // 标签关系（含 tag_order 保序）
  const tagNames = await (adminEntries as never as {
    listEntryTagNames: (entryId: string) => Promise<string[]>;
  }).listEntryTagNames(created.id);
  assert.deepEqual(tagNames, ["TypeScript", "前端"], "标签顺序必须与表单一致");

  // 版本快照
  const revisions = await (adminEntries as never as {
    listRevisions: (entryId: string) => Promise<{ version: number; changeNote: string | null }[]>;
  }).listRevisions(created.id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].version, 1);
  assert.equal(revisions[0].changeNote, "创建草稿");

  // 审计
  const audit = await (adminEntries as never as {
    listAuditLogs: (options: unknown) => Promise<{ rows: { action: string; actorId: string | null }[]; total: number }>;
  }).listAuditLogs({});
  assert.equal(audit.total, 1);
  assert.equal(audit.rows[0].action, "entry.create");
  assert.equal(audit.rows[0].actorId, authStub.ADMIN_USER_ID, "审计必须记到操作人");

  // 缓存标签
  assert.deepEqual(
    cacheStub.updatedTags.slice().sort(),
    ["entries:all", "entries:blog", "entry:blog:hello-platform"].sort(),
    "三个缓存标签都要失效",
  );
  assert.ok(
    cacheStub.revalidatedPaths.some((item) => item.path === "/admin" && item.type === "layout"),
    "后台布局缓存也要失效",
  );
});

test("createEntryAction：slug 重复返回字段错误而不是抛异常", async () => {
  await createAdminDatabase();

  await catchRedirect(() => actions.createEntryAction(blogForm()));
  const second = await actions.createEntryAction(blogForm());

  assert.equal(second.ok, false);
  assert.ok(second.fieldErrors?.slug, "重复 slug 必须落到 slug 字段上");
  assert.match(String(second.fieldErrors?.slug), /已存在/);
});

/* -------------------------------------------------------------------------- */
/* 5. 保存与乐观锁                                                              */
/* -------------------------------------------------------------------------- */

test("saveEntryAction：版本 +1、写第二条快照、审计记 slug/version 前后值", async () => {
  await createAdminDatabase();
  await catchRedirect(() => actions.createEntryAction(blogForm()));

  const listed = await adminEntries.listEntries({});
  const entryId = listed.rows[0].id;

  cacheStub.resetCacheCalls();
  const result = await actions.saveEntryAction(
    blogForm({ entryId, title: "改过的标题", expectedVersion: "1" }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.message, "已保存（版本 2）");

  const after = await adminEntries.getEntryById(entryId);
  assert.equal(after?.version, 2);
  assert.equal(after?.title, "改过的标题");

  const revisions = await adminEntries.listRevisions(entryId);
  assert.equal(revisions.length, 2, "每次保存都留一个保存点");

  const audit = await adminEntries.listAuditLogs({});
  const saveAudit = audit.rows.find((row) => row.action === "entry.save");
  assert.ok(saveAudit, "保存必须写审计");
  const detail = saveAudit!.detail as { versionBefore: number; versionAfter: number };
  assert.equal(detail.versionBefore, 1);
  assert.equal(detail.versionAfter, 2);
});

test("saveEntryAction：版本过期时拒绝写入（乐观锁），库里内容不变", async () => {
  await createAdminDatabase();
  await catchRedirect(() => actions.createEntryAction(blogForm()));

  const listed = await adminEntries.listEntries({});
  const entryId = listed.rows[0].id;

  // 先正常保存一次，把版本推到 2。
  await actions.saveEntryAction(blogForm({ entryId, expectedVersion: "1" }));

  // 再用过期的版本号（1）保存，必须被拒。
  const stale = await actions.saveEntryAction(
    blogForm({ entryId, title: "不应该写进去", expectedVersion: "1" }),
  );

  assert.equal(stale.ok, false);
  assert.match(String(stale.formError), /版本冲突/);
  assert.equal(stale.currentVersion, 2, "要把当前版本回传，页面才能提示刷新");

  const after = await adminEntries.getEntryById(entryId);
  assert.equal(after?.version, 2, "冲突时不能偷偷把版本推上去");
  assert.equal(after?.title, "平台化第一篇", "冲突时不能改内容");
});

test("saveEntryAction：改 slug 时旧地址的缓存标签也要失效", async () => {
  await createAdminDatabase();
  await catchRedirect(() => actions.createEntryAction(blogForm()));

  const listed = await adminEntries.listEntries({});
  const entryId = listed.rows[0].id;

  cacheStub.resetCacheCalls();
  const result = await actions.saveEntryAction(
    blogForm({ entryId, slug: "renamed-post", expectedVersion: "1" }),
  );
  assert.equal(result.ok, true);

  assert.ok(
    cacheStub.updatedTags.includes("entry:blog:hello-platform"),
    "旧 slug 的详情页缓存必须失效，否则旧 URL 还在吐旧内容",
  );
  assert.ok(cacheStub.updatedTags.includes("entry:blog:renamed-post"));
});

/* -------------------------------------------------------------------------- */
/* 6. 状态流转                                                                  */
/* -------------------------------------------------------------------------- */

test("publishEntryAction：draft → published，published_at 取东八区零点", async () => {
  await createAdminDatabase();
  await catchRedirect(() => actions.createEntryAction(blogForm()));

  const listed = await adminEntries.listEntries({});
  const entryId = listed.rows[0].id;

  cacheStub.resetCacheCalls();
  const result = await actions.publishEntryAction(
    (() => {
      const form = new FormData();
      form.set("entryId", entryId);
      form.set("expectedVersion", "1");
      return form;
    })(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.message, "已发布");

  const after = await adminEntries.getEntryById(entryId);
  assert.equal(after?.publishStatus, "published");
  assert.equal(after?.version, 2, "发布也是一次写入，版本要 +1");
  assert.ok(after?.publishedAt, "发布必须写 published_at");
  // displayDate = 2026-03-04，东八区零点 = 2026-03-03T16:00:00Z
  assert.equal(after!.publishedAt!.toISOString(), "2026-03-03T16:00:00.000Z");

  assert.ok(cacheStub.updatedTags.includes("entry:blog:hello-platform"));
});

test("publishEntryAction：正文为空时拒绝发布", async () => {
  await createAdminDatabase();
  // 绕过表单校验直接插一条空正文的草稿，模拟「历史脏数据」。
  const db = await adminDb.getAdminDb();
  await db.insert(entries).values({
    kind: "blog",
    slug: "empty-body",
    title: "有标题没正文",
    summary: "摘要",
    body_md: "   ",
    publish_status: "draft",
    display_date: "2026-03-04",
    data: { category: "工程实践" },
  });

  // 表对象在本文件里被断言成 `never`（为了让 `db.insert()` 接受任意表），
  // 拿 id 走读路径更省事，也顺带验证了按 kind+slug 查得到草稿。
  const draft = await adminEntries.getEntryDetail("blog", "empty-body");
  assert.ok(draft, "直接插入的草稿应当能查到");
  const entryId = draft!.id;

  const result = await actions.publishEntryAction(
    (() => {
      const form = new FormData();
      form.set("entryId", entryId);
      form.set("expectedVersion", "1");
      return form;
    })(),
  );

  assert.equal(result.ok, false);
  assert.match(String(result.formError), /正文为空/);

  const after = await adminEntries.getEntryById(entryId);
  assert.equal(after?.publishStatus, "draft", "拒绝发布时状态不能变");
});

test("scheduleEntryAction：过去时间被拒、将来时间被接受", async () => {
  await createAdminDatabase();
  await catchRedirect(() => actions.createEntryAction(blogForm()));

  const listed = await adminEntries.listEntries({});
  const entryId = listed.rows[0].id;

  const past = new Date(Date.now() - 60_000).toISOString();
  const rejected = await actions.scheduleEntryAction(
    (() => {
      const form = new FormData();
      form.set("entryId", entryId);
      form.set("expectedVersion", "1");
      form.set("scheduledAt", past);
      return form;
    })(),
  );
  assert.equal(rejected.ok, false);
  assert.ok(rejected.fieldErrors?.scheduledAt, "定时时间错误要落到字段上");

  const future = new Date(Date.now() + 3_600_000).toISOString();
  const accepted = await actions.scheduleEntryAction(
    (() => {
      const form = new FormData();
      form.set("entryId", entryId);
      form.set("expectedVersion", "1");
      form.set("scheduledAt", future);
      return form;
    })(),
  );
  assert.equal(accepted.ok, true);

  const after = await adminEntries.getEntryById(entryId);
  assert.equal(after?.publishStatus, "scheduled");
});

test("archiveEntryAction：归档后状态为 archived，仍能按 id 查到（不删数据）", async () => {
  await createAdminDatabase();
  await catchRedirect(() => actions.createEntryAction(blogForm()));

  const listed = await adminEntries.listEntries({});
  const entryId = listed.rows[0].id;

  const result = await actions.archiveEntryAction(
    (() => {
      const form = new FormData();
      form.set("entryId", entryId);
      form.set("expectedVersion", "1");
      return form;
    })(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.message, "已归档");

  const after = await adminEntries.getEntryById(entryId);
  assert.equal(after?.publishStatus, "archived");
  assert.ok(after, "归档不是删除，行还在");
});

/* -------------------------------------------------------------------------- */
/* 7. 批量归档                                                                  */
/* -------------------------------------------------------------------------- */

test("bulkArchiveAction：只归档选中项，已归档的跳过，未选中的不动", async () => {
  await createAdminDatabase();

  await catchRedirect(() => actions.createEntryAction(blogForm({ slug: "post-a", title: "A" })));
  await catchRedirect(() => actions.createEntryAction(blogForm({ slug: "post-b", title: "B" })));
  await catchRedirect(() => actions.createEntryAction(blogForm({ slug: "post-c", title: "C" })));

  const listed = await adminEntries.listEntries({});
  const bySlug = new Map(listed.rows.map((row) => [row.slug, row]));

  const form = new FormData();
  form.append("entryId", bySlug.get("post-a")!.id);
  form.append("entryId", bySlug.get("post-b")!.id);

  const result = await actions.bulkArchiveAction(form);
  assert.equal(result.ok, true);

  const after = await adminEntries.listEntries({});
  const statusOf = new Map(after.rows.map((row) => [row.slug, row.publishStatus]));
  assert.equal(statusOf.get("post-a"), "archived");
  assert.equal(statusOf.get("post-b"), "archived");
  assert.equal(statusOf.get("post-c"), "draft", "没选中的不能被顺手归档");
});

test("bulkArchiveAction：一条都没选时返回错误而不是静默成功", async () => {
  await createAdminDatabase();
  const result = await actions.bulkArchiveAction(new FormData());
  assert.equal(result.ok, false);
  assert.match(String(result.formError), /没有选中/);
});

/* -------------------------------------------------------------------------- */
/* 8. 版本恢复                                                                  */
/* -------------------------------------------------------------------------- */

test("restoreRevisionAction：恢复内容但**不回滚状态**，并生成第 N+1 版", async () => {
  await createAdminDatabase();
  await catchRedirect(() => actions.createEntryAction(blogForm()));

  const listed = await adminEntries.listEntries({});
  const entryId = listed.rows[0].id;

  // v1 = 原始；保存成 v2（改了标题）；再发布成 v3。
  await actions.saveEntryAction(blogForm({ entryId, title: "第二版标题", expectedVersion: "1" }));
  await actions.publishEntryAction(
    (() => {
      const form = new FormData();
      form.set("entryId", entryId);
      form.set("expectedVersion", "2");
      return form;
    })(),
  );

  const beforeRestore = await adminEntries.getEntryById(entryId);
  assert.equal(beforeRestore?.version, 3);
  assert.equal(beforeRestore?.publishStatus, "published");

  // 恢复到 v1（原始标题）。
  const restoreForm = new FormData();
  restoreForm.set("entryId", entryId);
  restoreForm.set("version", "1");
  restoreForm.set("expectedVersion", "3");
  const result = await actions.restoreRevisionAction(restoreForm);
  assert.equal(result.ok, true);

  const after = await adminEntries.getEntryById(entryId);
  assert.equal(after?.title, "平台化第一篇", "内容要恢复成 v1 的");
  assert.equal(after?.version, 4, "恢复要生成新版本，不能覆盖历史");
  assert.equal(after?.publishStatus, "published", "恢复内容不等于撤下文章，状态不回滚");

  const revisions = await adminEntries.listRevisions(entryId);
  assert.equal(revisions.length, 4);
  assert.match(String(revisions[0].changeNote), /恢复自版本 1/);
});

/* -------------------------------------------------------------------------- */
/* 9. 第一道关：未登录时所有写操作都必须拒绝                                     */
/* -------------------------------------------------------------------------- */

test("第一道关：没有会话时所有写 action 都抛错，且一行都不写", async () => {
  await createAdminDatabase();

  authStub.setCurrentAdmin(null);
  try {
    await assert.rejects(
      () => actions.createEntryAction(blogForm()),
      /未登录/,
      "未登录必须直接拒绝",
    );

    const stillEmpty = await adminEntries.listEntries({});
    assert.equal(stillEmpty.total, 0, "被拒绝的请求不能留下半条数据");

    const audit = await adminEntries.listAuditLogs({});
    assert.equal(audit.total, 0, "被拒绝的请求也不该写审计");
  } finally {
    authStub.setCurrentAdmin({ id: authStub.ADMIN_USER_ID, githubLogin: "tester" });
  }
});

/* -------------------------------------------------------------------------- */
/* 10. 读路径：筛选 / 分页 / 统计                                                */
/* -------------------------------------------------------------------------- */

test("listEntries：按状态与关键词筛选，分页参数越界自动钳住", async () => {
  await createAdminDatabase();

  await catchRedirect(() => actions.createEntryAction(blogForm({ slug: "alpha", title: "第一篇" })));
  await catchRedirect(() => actions.createEntryAction(blogForm({ slug: "beta", title: "第二篇" })));

  const beta = (await adminEntries.listEntries({})).rows.find((row) => row.slug === "beta")!;
  await actions.publishEntryAction(
    (() => {
      const form = new FormData();
      form.set("entryId", beta.id);
      form.set("expectedVersion", "1");
      return form;
    })(),
  );

  const published = await adminEntries.listEntries({ status: "published" });
  assert.equal(published.total, 1);
  assert.equal(published.rows[0].slug, "beta");

  const drafts = await adminEntries.listEntries({ status: "draft" });
  assert.equal(drafts.total, 1);
  assert.equal(drafts.rows[0].slug, "alpha");

  const searched = await adminEntries.listEntries({ query: "第一篇" });
  assert.equal(searched.total, 1);

  const clamped = await adminEntries.listEntries({ page: 99, pageSize: 1 });
  assert.equal(clamped.page, clamped.pageCount, "页码越界要钳到最后一页，不能返回空表");
});

test("countEntriesByKindAndStatus：一次 GROUP BY 就能画出总览矩阵", async () => {
  await createAdminDatabase();
  await catchRedirect(() => actions.createEntryAction(blogForm()));

  const stats = await adminEntries.countEntriesByKindAndStatus();
  const draftBlog = stats.find((row) => row.kind === "blog" && row.status === "draft");
  assert.equal(draftBlog?.value, 1);
});

/* -------------------------------------------------------------------------- */
/* 11. users 表与审计的 JOIN                                                    */
/* -------------------------------------------------------------------------- */

test("listAuditLogs：actorLogin 走 LEFT JOIN users，actor_id 为空时整行仍保留", async () => {
  // `createAdminDatabase()` 已经插过这条用户（`entries.created_by` 有外键），
  // 这里不能再插一次 —— 会撞 `users_pkey`。
  await createAdminDatabase();

  const db = await adminDb.getAdminDb();

  await catchRedirect(() => actions.createEntryAction(blogForm()));

  // 再插一条没有操作人的系统日志（actor_id 可空）。
  await db.insert(auditLogs).values({
    actor_id: null,
    action: "system.migrate",
    entity_type: "system",
    entity_id: null,
    detail: {},
  });

  const audit = await adminEntries.listAuditLogs({});
  assert.equal(audit.total, 2, "LEFT JOIN 不能把 actor_id 为空的行吞掉");

  const mine = audit.rows.find((row) => row.action === "entry.create");
  assert.equal(mine?.actorLogin, "tester", "actorLogin 要 JOIN 出来");

  const system = audit.rows.find((row) => row.action === "system.migrate");
  assert.equal(system?.actorLogin, null);
});

/* -------------------------------------------------------------------------- */
/* 12. 事务原子性                                                               */
/* -------------------------------------------------------------------------- */

test("创建失败时事务整体回滚：entries / revisions / audit 都不留残骸", async () => {
  await createAdminDatabase();
  await catchRedirect(() => actions.createEntryAction(blogForm()));

  // 第二次用同一个 slug，插入 entries 时就会撞唯一键。
  const duplicate = await actions.createEntryAction(blogForm({ title: "重复" }));
  assert.equal(duplicate.ok, false);

  const db = await adminDb.getAdminDb();
  const revisionCount = await db.select().from(entryRevisions);
  const auditCount = await db.select().from(auditLogs);
  const tagLinks = await db.select().from(entryTags);

  assert.equal(revisionCount.length, 1, "只应有第一次创建的那条快照");
  assert.equal(auditCount.length, 1, "失败的创建不能留下审计");
  assert.equal(tagLinks.length, 2, "失败的创建不能留下标签关系");
  void tags;
});

/* -------------------------------------------------------------------------- */
/* 13. 登出审计的写入顺序                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 这一条来自一次真实验收。
 *
 * P4 收口时往 Neon 里插了一条本地会话打后台全链路，点登出后查 `audit_logs`，
 * 抓到一行 `action='auth.sign_out', actor_id=null, entity_id=null` —— 审计等于
 * 没记。根因在 `events.signOut`：`@auth/core/lib/actions/signout.js` 先把
 * `adapter.deleteSession(sessionToken)` 的返回值塞进 `message.session`，但
 * `deleteSession` 的契约是 `void`（drizzle adapter 的实现也只 delete 不
 * returning），所以事件里永远拿不到 userId。
 *
 * 修法是「先记录、后登出」，由 `adminSignOutAction` 保证顺序。这个顺序不能在
 * 代码审查里靠肉眼守，所以在这里断言。
 */
test("adminSignOutAction：先写审计、再真正登出（events.signOut 拿不到 userId）", async () => {
  await createAdminDatabase();
  authStub.resetSignOutSequence();

  await actions.adminSignOutAction();

  assert.deepEqual(
    authStub.signOutSequence,
    [`audit:${authStub.ADMIN_USER_ID}`, "signOut:/login"],
    "必须先在还有会话时写审计，再调 signOut；顺序反了审计就拿不到操作人",
  );
});

test("adminSignOutAction：没有会话时只登出，不写一行全 null 的假审计", async () => {
  await createAdminDatabase();
  authStub.resetSignOutSequence();
  authStub.setCurrentAdmin(null);

  try {
    await actions.adminSignOutAction();
  } finally {
    authStub.setCurrentAdmin({ id: authStub.ADMIN_USER_ID, githubLogin: "tester" });
  }

  assert.deepEqual(
    authStub.signOutSequence,
    ["audit:none", "signOut:/login"],
    "未登录时 recordSignOutBeforeClearing 不写审计；signOut 仍要执行（清掉可能残留的 cookie）",
  );
});
