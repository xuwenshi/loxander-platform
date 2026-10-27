/**
 * 运维台的离线验收（不需要 Next 起服务，不需要真库）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 * 运维台的风险集中在两处，而这两处**都不会被 `tsc` 抓到**：
 *
 * 1. **只读网关是否真的挡住了写操作**（`lib/ops/db-readonly.ts`）。
 *    它的四道闸里有三道是字符串判断（单条 / 开头关键字 / 禁用关键词），
 *    写错一个正则的后果是「看起来还在防，其实全放行」—— 编译通过、
 *    页面正常、查询照跑。只有拿一批真实 SQL 逐条断言才看得出来。
 *
 * 2. **每个 Server Action 是否都做了 `requireAdmin()`**（`lib/ops/actions.ts`）。
 *    Next 16 的 `proxy.md:249-251` 明确说 Server Function 不是独立路由，
 *    proxy matcher 拦不到；漏一个 action 的守卫就是一条匿名可达的接口。
 *    这个文件把「未登录时每个 action 都必须失败」变成可断言的。
 *
 * ── 三个必须打桩的东西（与 `lib/admin/__tests__` 同源）────────────────
 * 1. `server-only` → 空模块（真实包在非 RSC 环境直接抛错）。
 * 2. `next/cache`  → 空替身（运维台不写缓存，但没有它会加载失败）。
 * 3. `../auth`     → `lib/admin/__tests__/auth-stub.ts`（真实 `requireAdmin()`
 *                    走 `auth()` → `next/headers` 读 cookie，纯 node 必抛）。
 *
 * 另外 `next` 包没有 `exports` 字段，`next/server` 之类在纯 node 下解析不到，
 * 必须在 resolve 钩子里补 `.js` 后缀（与 admin 测试同一个坑）。
 *
 * 跑法：`node --test-isolation=none apps/web/src/lib/ops/__tests__/ops.test.ts`
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `apps/web/src`（本文件在 `src/lib/ops/__tests__/` 下，往上三层）。 */
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

    // 所有 `../auth` / `@/lib/auth` 一律换成替身（运维台与后台共用同一套身份）。
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : "";
    const fromLibDir = parent.includes(`${resolvePath(SRC_DIR, "lib")}`);
    if ((specifier === "../auth" && fromLibDir) || specifier === "@/lib/auth") {
      return { url: pathToFileURL(AUTH_STUB).href, shortCircuit: true };
    }

    // `next` 没有 exports 字段，`next/server` 在纯 node 下会报
    // `Cannot find module ...\next\server`。补 `.js` 即可。
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

// `APP_ROOT` 的探测依赖 cwd（有 content/ 且有 package.json 才是应用根），
// 站点的运行时 cwd 就是 `apps/web`，测试里必须切过去。
process.chdir(WEB_DIR);

import { test } from "node:test";
import assert from "node:assert/strict";

const requireFromRepo = createRequire(pathToFileURL(resolvePath(REPO_DIR, "package.json")).href);
/** 依赖都在仓库根 node_modules（npm workspaces hoist）。 */
const importFromRepo = (name: string) =>
  import(pathToFileURL(requireFromRepo.resolve(name)).href) as Promise<never>;

const authStub = (await import(pathToFileURL(AUTH_STUB).href)) as typeof import("../../admin/__tests__/auth-stub");
const readOnly = (await import(pathToFileURL(resolvePath(SRC_DIR, "lib/ops/db-readonly.ts")).href)) as typeof import("../db-readonly");
const capabilities = (await import(pathToFileURL(resolvePath(SRC_DIR, "lib/ops/capabilities.ts")).href)) as typeof import("../capabilities");
const runner = (await import(pathToFileURL(resolvePath(SRC_DIR, "lib/ops/runner.ts")).href)) as typeof import("../runner");
const opsActions = (await import(pathToFileURL(resolvePath(SRC_DIR, "lib/ops/actions.ts")).href)) as typeof import("../actions");
const schema = (await import(pathToFileURL(resolvePath(REPO_DIR, "db/schema.ts")).href)) as never;

const { auditLogs, users } = schema as unknown as { auditLogs: never; users: never };

/* -------------------------------------------------------------------------- */
/* 1. 只读网关：允许的与必须拒绝的                                               */
/* -------------------------------------------------------------------------- */

test("只读网关：合法的只读语句必须放行", () => {
  const allowed = [
    "select 1",
    "SELECT * FROM entries LIMIT 5",
    "  select current_setting('default_transaction_read_only')  ",
    "with recent as (select * from entries order by created_at desc limit 10) select * from recent",
    "values (1), (2)",
    "table entries",
    "SELECT kind, count(*) FROM entries GROUP BY kind",
    // 末尾分号是允许的（人写 SQL 的习惯）。
    "select 1;",
    // 关键字出现在标识符/字面量里不能被误判。
    "select updated_at, created_at from entries",
    "select 'DROP TABLE entries' as note",
    "select \"delete\" from entries",
    // 行注释与块注释要能剥掉。
    "select 1 -- 这是注释里的 DELETE\n",
    "select /* UPDATE 不算 */ 1",
  ];

  for (const sql of allowed) {
    assert.equal(readOnly.checkReadOnlySql(sql), null, `应当放行：${JSON.stringify(sql)}`);
  }
});

test("只读网关：写操作与危险语句必须拒绝", () => {
  const rejected = [
    ["", "empty"],
    ["   ", "empty"],
    ["insert into entries (kind) values ('blog')", "not_select"],
    ["update entries set title = 'x'", "not_select"],
    ["delete from entries", "not_select"],
    ["drop table entries", "not_select"],
    ["truncate entries", "not_select"],
    ["create table t (id int)", "not_select"],
    ["alter table entries add column x int", "not_select"],
    ["grant all on entries to public", "not_select"],
    // 多条语句（中间的分号）。
    ["select 1; select 2", "multiple_statements"],
    // 以 SELECT 开头但内部有写操作。
    ["select * from entries into new_entries", "write_keyword"],
    ["with x as (select 1) insert into entries (kind) select 'blog'", "write_keyword"],
  ];

  for (const [sql, expectedCode] of rejected) {
    const reason = readOnly.checkReadOnlySql(sql as string);
    assert.notEqual(reason, null, `应当拒绝：${JSON.stringify(sql)}`);
    assert.equal(
      (reason as { code: string }).code,
      expectedCode,
      `拒绝原因应当是 ${expectedCode}，实际 ${(reason as { code: string }).code}（${JSON.stringify(sql)}）`,
    );
  }
});

test("只读网关：字面量与注释里的分号不能被当成多语句", () => {
  // 这是「用 stripped 判断分号」那条注释的回归：如果忘了先剥离字面量，
  // `where title = ';'` 会被误判成两条语句。
  assert.equal(readOnly.checkReadOnlySql("select * from entries where title = ';'"), null);
  assert.equal(readOnly.checkReadOnlySql("select ';' as semi"), null);
  assert.equal(readOnly.checkReadOnlySql("select 1 -- ;\n"), null);
  assert.equal(readOnly.checkReadOnlySql("select /* ; */ 1"), null);
});

test("只读网关：剥离函数把字面量换成占位符，不泄漏原文", () => {
  const stripped = readOnly.stripLiteralsAndComments("select 'secret-value' as x -- tail");
  assert.ok(!stripped.includes("secret-value"), "字面量内容不应出现在剥离结果里");
  assert.ok(!stripped.includes("tail"), "行注释内容不应出现在剥离结果里");
  assert.ok(stripped.toLowerCase().includes("select"), "语法成分要保留");
});

test("只读网关：超长 SQL 拒绝", () => {
  const huge = "select " + "a,".repeat(600_000) + "b";
  const reason = readOnly.checkReadOnlySql(huge);
  assert.notEqual(reason, null);
  assert.equal((reason as { code: string }).code, "too_long");
});

test("只读网关：常量与允许清单是如实的", () => {
  assert.equal(readOnly.MAX_ROWS, 500);
  assert.equal(readOnly.STATEMENT_TIMEOUT_MS, 8_000);
  assert.equal(readOnly.QUERY_TIMEOUT_MS, 15_000);
  assert.ok(readOnly.ALLOWED_HEADS.includes("SELECT"));
  assert.ok(readOnly.ALLOWED_HEADS.includes("WITH"));
  // INTO 必须在禁用清单里：`select ... into new_table` 会建表。
  assert.ok(readOnly.FORBIDDEN_KEYWORDS.includes("INTO"));
});

/* -------------------------------------------------------------------------- */
/* 2. 能力矩阵                                                                  */
/* -------------------------------------------------------------------------- */

test("能力矩阵：18 项，分组齐全，恢复能力必须是 disabled", () => {
  const list = capabilities.buildCapabilities();
  assert.equal(list.length, 18, `应当 18 项，实际 ${list.length}`);

  const groups = new Set(list.map((item) => item.group));
  for (const group of ["database", "script", "test", "runtime", "export", "env"]) {
    assert.ok(groups.has(group as never), `缺少分组 ${group}`);
  }

  const ids = new Set(list.map((item) => item.id));
  for (const id of [
    "db.schema",
    "db.query",
    "db.migrations",
    "db.backup",
    "db.restore",
    "script.preflight",
    "script.rollback",
    "script.css",
    "test.unit",
    "test.browser",
    "runtime.health",
    "runtime.routes",
    "runtime.version",
    "export.markdown",
    "export.verify",
    "env.matrix",
    "env.vercel",
    "env.neon",
  ]) {
    assert.ok(ids.has(id as never), `缺少能力 ${id}`);
  }

  const restore = list.find((item) => item.id === "db.restore");
  assert.ok(restore, "db.restore 必须存在（要如实告诉用户它不可用）");
  assert.equal(restore!.availability, "disabled");
  assert.ok(restore!.reason && restore!.reason.length > 0, "disabled 必须带原因");
  assert.equal(restore!.mutates, true, "恢复是写操作");

  // 每一项都要么 available 要么有 reason，不能「不可用且不说为什么」。
  for (const item of list) {
    if (item.availability !== "available") {
      assert.ok(item.reason && item.reason.length > 0, `${item.id} 不可用但没有原因`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 3. 检查执行器                                                                */
/* -------------------------------------------------------------------------- */

test("检查执行器：注册表 6 项，只有 routes 需要 baseUrl", () => {
  assert.equal(runner.CHECK_REGISTRY.length, 6);
  const needsBaseUrl = runner.CHECK_REGISTRY.filter((item) => item.needsBaseUrl);
  assert.equal(needsBaseUrl.length, 1);
  assert.equal(needsBaseUrl[0].id, "routes");
});

test("检查执行器：本地五项都能跑完并给出结构完整的结论", async () => {
  const results = await runner.runAllLocalChecks();
  assert.equal(results.length, 5, "runAllLocalChecks 应当跑 5 项（跳过 routes）");

  for (const result of results) {
    assert.equal(typeof result.id, "string");
    assert.equal(typeof result.label, "string");
    assert.equal(typeof result.ok, "boolean");
    assert.equal(typeof result.passed, "number");
    assert.equal(typeof result.total, "number");
    assert.ok(Array.isArray(result.lines));
    assert.equal(typeof result.elapsedMs, "number");
    assert.equal(
      result.passed + (result.total - result.passed),
      result.total,
      `${result.id}: passed 不能超过 total`,
    );
    assert.equal(result.ok, result.passed === result.total, `${result.id}: ok 必须等于全通过`);
    // 每一行都要有可读的名字与结论。
    for (const line of result.lines) {
      assert.ok(line.name.length > 0, `${result.id}: 有行没有名字`);
      assert.equal(typeof line.ok, "boolean");
      assert.ok(line.detail.length > 0, `${result.id}/${line.name}: 有行没有 detail`);
    }
  }
});

test("检查执行器：缺 baseUrl 时 routes 如实报错而不是假装通过", async () => {
  const result = await runner.runCheck("routes");
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.includes("baseUrl"), "必须说明缺 baseUrl");
  assert.equal(result.total, 0);
});

test("检查执行器：子进程能力探测不会抛错，且如实报告", () => {
  const probe = runner.probeSpawn();
  assert.equal(typeof probe.available, "boolean");
  assert.equal(typeof probe.elapsedMs, "number");
  if (!probe.available) {
    assert.ok(probe.error !== null || probe.code !== null, "不可用时必须有原因");
  }
});

test("检查执行器：必须去终端跑的脚本清单是如实的", () => {
  assert.ok(runner.SUBPROCESS_SCRIPTS.length >= 5);
  for (const item of runner.SUBPROCESS_SCRIPTS) {
    assert.ok(item.script.startsWith("scripts/") || item.script.startsWith("db/"), item.script);
    assert.ok(item.npm.startsWith("npm run"), item.npm);
    assert.ok(item.why.length > 0, `${item.script} 没写为什么`);
  }
  const scripts = runner.SUBPROCESS_SCRIPTS.map((item) => item.script);
  assert.ok(scripts.some((s) => s.includes("preflight")), "preflight 必须在清单里");
  assert.ok(scripts.some((s) => s.includes("browser-acceptance")), "浏览器验收必须在清单里");
  assert.ok(scripts.some((s) => s.includes("rollback")), "回滚演练必须在清单里");
});

/* -------------------------------------------------------------------------- */
/* 4. 每个 Server Action 都必须有守卫                                           */
/* -------------------------------------------------------------------------- */

test("Server Actions：未登录时每一个都必须失败（没有匿名可达的入口）", async () => {
  authStub.setCurrentAdmin(null);

  // 逐个调，全部必须 ok:false 且错误信息来自 requireAdmin。
  const calls: [string, () => Promise<{ ok: boolean; error?: string }>][] = [
    ["loadCapabilitiesAction", () => opsActions.loadCapabilitiesAction()],
    ["loadTablesAction", () => opsActions.loadTablesAction()],
    ["loadTableStructureAction", () => opsActions.loadTableStructureAction("entries")],
    ["runQueryAction", () => opsActions.runQueryAction("select 1")],
    ["loadMigrationStatusAction", () => opsActions.loadMigrationStatusAction()],
    ["loadBackupsAction", () => opsActions.loadBackupsAction()],
    ["createBackupAction", () => opsActions.createBackupAction()],
    ["verifyBackupAction", () => opsActions.verifyBackupAction("db-20260101-000000.json")],
    ["probeDatabaseAction", () => opsActions.probeDatabaseAction()],
    ["probeRoutesAction", () => opsActions.probeRoutesAction("http://127.0.0.1:1")],
    ["checkVersionAction", () => opsActions.checkVersionAction()],
    ["runCheckAction", () => opsActions.runCheckAction("env")],
    ["runAllChecksAction", () => opsActions.runAllChecksAction()],
    ["probeSpawnAction", () => opsActions.probeSpawnAction()],
    ["loadEnvMatrixAction", () => opsActions.loadEnvMatrixAction()],
    ["loadVercelStatusAction", () => opsActions.loadVercelStatusAction()],
    ["loadNeonStatusAction", () => opsActions.loadNeonStatusAction()],
  ];

  assert.equal(calls.length, 17, "action 数量变了就要同步改这个断言");

  for (const [name, call] of calls) {
    const result = await call();
    assert.equal(result.ok, false, `${name} 未登录时竟然成功了`);
    assert.ok(
      result.error && result.error.includes("未登录"),
      `${name} 的失败原因应当是「未登录」，实际：${result.error}`,
    );
  }

  // 还原，避免污染后面的用例。
  authStub.setCurrentAdmin({ id: authStub.ADMIN_USER_ID, githubLogin: "tester" });
});

test("Server Actions：查询被拒绝时必须写审计（安全事件要留痕）", async () => {
  // 起一个跑过全部迁移的 PGlite，注入给后台 db 层。
  const { PGlite } = await importFromRepo("@electric-sql/pglite");
  const { drizzle } = await importFromRepo("drizzle-orm/pglite");
  const { readFileSync } = await import("node:fs");

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
    select: () => { from: (table: unknown) => Promise<unknown[]> };
  };

  await db.insert(users).values({
    id: authStub.ADMIN_USER_ID,
    name: "测试管理员",
    email: "ops@example.com",
    github_login: "tester",
  });

  const adminDb = (await import(pathToFileURL(resolvePath(SRC_DIR, "lib/admin/db.ts")).href)) as typeof import("../../admin/db");
  adminDb.setAdminDatabase(db as never);

  authStub.setCurrentAdmin({ id: authStub.ADMIN_USER_ID, githubLogin: "tester" });

  // `runQueryAction()` 第一件事是看有没有 DATABASE_URL，没有就直接回
  // `unavailable`（连 SQL 检查都不会跑）。这里塞一个**连不上**的假连接串：
  // 被拒绝的语句在 `checkReadOnlySql()` 就被挡下，根本不会走到建连，
  // 所以它只是为了让 action 进到「检查 SQL」这一步，不代表要连库。
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://nobody:nobody@127.0.0.1:1/nodb";

  try {
    // 一条写操作：必须被拒绝，并留下 ops.query_rejected 审计。
    const result = await opsActions.runQueryAction("delete from entries");
    assert.equal(result.ok, true, "action 本身要成功返回（拒绝是预期结果，不是异常）");
    assert.equal(result.data?.kind, "rejected", `应当是 rejected，实际 ${JSON.stringify(result.data)}`);
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }

  const rows = (await db.select().from(auditLogs)) as { action: string; actor_id: string | null }[];
  const rejected = rows.filter((row) => row.action === "ops.query_rejected");
  assert.equal(rejected.length, 1, `应当有 1 条 ops.query_rejected 审计，实际 ${rejected.length}`);
  assert.equal(rejected[0].actor_id, authStub.ADMIN_USER_ID, "审计必须记到具体管理员");

  await client.close();
});
