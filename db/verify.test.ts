/**
 * PGlite 迁移闸门的断言集。
 *
 * 跑法（两种都实测可用，二选一）：
 *   node db/verify.test.ts
 *   node --test-isolation=none db/verify.test.ts
 *
 * **不能**用 `node --test db/verify.test.ts`（package.json 里 `db:verify` 现在就是这句）：
 *   本机沙箱禁止管道 stdio 子进程，`node --test <file>` 默认 fork 一个子进程去跑
 *   测试文件，直接 `Error: spawn EPERM`（实测：`ℹ tests 1 / ℹ fail 1`，退出码 -1）。
 *   加上 `--test-isolation=none` 后测试在**当前进程内**执行，14 项全过、退出码 0；
 *   直接 `node db/verify.test.ts` 同理，效果完全一致。
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';

import {
  EXPECTED_ENTRY_COLUMNS,
  EXPECTED_ENTRY_TAG_COLUMNS,
  EXPECTED_STATEMENT_COUNT,
  EXPECTED_STATEMENT_COUNTS,
  EXPECTED_TABLES,
  createMigratedDatabase,
  expectFailure,
  expectSuccess,
  insertEntry,
  listColumns,
  listConstraints,
  listIndexes,
  listMigrationFiles,
  listTables,
  loadMigrationSql,
  probeGenRandomUuid,
  probeServerVersion,
  splitStatements,
} from './verify.ts';

let db: PGlite;
let statementCount = 0;
let appliedFiles: string[] = [];

before(async () => {
  const migrated = await createMigratedDatabase();
  db = migrated.db;
  statementCount = migrated.statements.length;
  appliedFiles = migrated.appliedFiles;
});

after(async () => {
  await db.close();
});

/* -------------------------------------------------------------------------- */
/* 0. 迁移本身                                                                 */
/* -------------------------------------------------------------------------- */

test('闸门 0：全部迁移文件按序执行成功，语句条数与清单一致', () => {
  const files = listMigrationFiles();
  const expectedFiles = Object.keys(EXPECTED_STATEMENT_COUNTS).sort();

  // 文件名清单必须与「期望条数表」一一对应：新增迁移却不登记，会在这里被拦住。
  assert.deepEqual(files.map((path) => path.split(/[\\/]/).pop()), expectedFiles);
  assert.deepEqual([...appliedFiles].sort(), expectedFiles);

  assert.equal(statementCount, EXPECTED_STATEMENT_COUNT);

  // 逐份迁移单独复查切分结果，并确认首尾语句的形状（防止文件被截断 / 乱序）。
  for (const path of files) {
    const name = path.split(/[\\/]/).pop() as string;
    const chunks = splitStatements(loadMigrationSql(path));
    assert.equal(chunks.length, EXPECTED_STATEMENT_COUNTS[name], `${name} 语句条数不符`);
  }

  const initChunks = splitStatements(loadMigrationSql(files[0]));
  assert.match(initChunks[0], /CREATE TABLE "audit_logs"/);
  assert.match(initChunks[initChunks.length - 1], /CREATE UNIQUE INDEX "tags_slug_idx"/);

  const orderChunks = splitStatements(loadMigrationSql(files[1]));
  assert.match(orderChunks[0], /ALTER TABLE "entry_tags" ADD COLUMN "tag_order"/);
  assert.match(orderChunks[1], /CREATE INDEX "entry_tags_entry_order_idx"/);
});

/* -------------------------------------------------------------------------- */
/* 1. 11 张表都存在（7 业务 + 4 认证）                                          */
/* -------------------------------------------------------------------------- */

test('闸门 1：11 张表全部存在（7 业务 + P4 认证四表）', async () => {
  const tables = await listTables(db);
  assert.deepEqual(tables, [...EXPECTED_TABLES].sort());
  assert.equal(tables.length, 11);

  // P4 认证四表单独正面断言：表名用复数（方案 §6.7），不是 adapter 默认的单数。
  for (const name of ['users', 'accounts', 'sessions', 'verification_tokens']) {
    assert.ok(tables.includes(name), `必须有 ${name} 表`);
  }
  for (const name of ['user', 'account', 'session', 'verificationToken']) {
    assert.ok(!tables.includes(name), `不能有单数表 ${name}（adapter 默认名，已用复数覆盖）`);
  }
});

/* -------------------------------------------------------------------------- */
/* 2. entries 列名与 db/schema.ts 完全一致                                      */
/* -------------------------------------------------------------------------- */

test('闸门 2：entries 的列名与 schema.ts 完全一致（含 publish_status 而非 status）', async () => {
  const columns = await listColumns(db, 'entries');
  const names = columns.map((column) => column.name);

  // 顺序也要一致 —— 顺序漂移意味着 migrate 与 schema 已经不同步。
  assert.deepEqual(names, [...EXPECTED_ENTRY_COLUMNS]);

  // 审查意见点名的三件事，单独正面断言，避免「列名对但语义错」。
  assert.ok(names.includes('publish_status'), '必须有 publish_status');
  assert.ok(!names.includes('status'), '不能有 status（已改名）');
  assert.ok(names.includes('display_date'), '必须有 display_date');
  assert.ok(names.includes('sort_order'), '必须有 sort_order');
  assert.ok(names.includes('data'), '必须有 data');
  assert.ok(names.includes('version'), '必须有 version');
  assert.ok(names.includes('created_by'), '必须有 created_by');
  assert.ok(names.includes('updated_by'), '必须有 updated_by');
});

test('闸门 2b：entries 的关键列类型 / 可空性 / 默认值与 schema.ts 对齐', async () => {
  const byName = new Map((await listColumns(db, 'entries')).map((c) => [c.name, c]));

  // publish_status：notNull + 默认 'draft'
  assert.equal(byName.get('publish_status')?.notNull, true);
  assert.match(byName.get('publish_status')?.defaultExpr ?? '', /'draft'/);

  // display_date 是 date 且可空（projects / goals 没有日期）
  assert.equal(byName.get('display_date')?.dataType, 'date');
  assert.equal(byName.get('display_date')?.notNull, false);

  // published_at 是 timestamptz —— 东八区零点落库必须带时区，否则 Vercel(UTC) 会退一天
  assert.equal(byName.get('published_at')?.dataType, 'timestamp with time zone');
  assert.equal(byName.get('published_at')?.notNull, false);

  // body_html 可空：导入脚本才填，手工建行可以先空着
  assert.equal(byName.get('body_html')?.dataType, 'text');
  assert.equal(byName.get('body_html')?.notNull, false);

  // data 是 jsonb 且 notNull 默认 '{}'
  assert.equal(byName.get('data')?.dataType, 'jsonb');
  assert.equal(byName.get('data')?.notNull, true);

  // version 默认 1
  assert.match(byName.get('version')?.defaultExpr ?? '', /1/);

  // sort_order 默认 999
  assert.match(byName.get('sort_order')?.defaultExpr ?? '', /999/);

  // 主键 id 默认走 gen_random_uuid()
  assert.match(byName.get('id')?.defaultExpr ?? '', /gen_random_uuid/);
});

/* -------------------------------------------------------------------------- */
/* 3~5. entries 的三条 CHECK                                                    */
/* -------------------------------------------------------------------------- */

test('闸门 3：entries_kind_check 生效（kind=post 必须失败）', async () => {
  const message = await expectFailure(
    db,
    `insert into entries (kind, slug, title) values ('post', 'probe-kind', 'x')`,
  );
  assert.match(message, /entries_kind_check/);
});

test('闸门 4：entries_publish_status_check 生效（publish_status=bogus 必须失败）', async () => {
  const message = await expectFailure(
    db,
    `insert into entries (kind, slug, title, publish_status) values ('blog', 'probe-status', 'x', 'bogus')`,
  );
  assert.match(message, /entries_publish_status_check/);
});

test('闸门 5：entries_version_positive_check 生效（version=0 必须失败）', async () => {
  const message = await expectFailure(
    db,
    `insert into entries (kind, slug, title, version) values ('blog', 'probe-version', 'x', 0)`,
  );
  assert.match(message, /entries_version_positive_check/);
});

/* -------------------------------------------------------------------------- */
/* 6. entries_kind_slug_idx 唯一                                                */
/* -------------------------------------------------------------------------- */

test('闸门 6：entries_kind_slug_idx 是唯一索引（同 kind+slug 插两次必须失败）', async () => {
  await insertEntry(db, 'blog', 'unique-probe');

  const message = await expectFailure(
    db,
    `insert into entries (kind, slug, title) values ('blog', 'unique-probe', 'dup')`,
  );
  assert.match(message, /entries_kind_slug_idx/);

  // 反证：不同 kind 的同名 slug 必须允许（唯一键是 (kind, slug) 复合）。
  const otherKindId = await insertEntry(db, 'diary', 'unique-probe');
  assert.match(otherKindId, /^[0-9a-f-]{36}$/);
});

/* -------------------------------------------------------------------------- */
/* 7~8. redirects 的两条 CHECK                                                  */
/* -------------------------------------------------------------------------- */

test('闸门 7：redirects_no_self_check 生效（source=target 必须失败）', async () => {
  const message = await expectFailure(
    db,
    `insert into redirects (source_path, target_path) values ('/a', '/a')`,
  );
  assert.match(message, /redirects_no_self_check/);

  // 反证：不同路径必须能插进去。
  const rows = await expectSuccess(
    db,
    `insert into redirects (source_path, target_path) values ('/old', '/new')`,
  );
  assert.equal(rows, 1);
});

test('闸门 8：redirects_status_code_check 生效（200 必须失败）', async () => {
  const message = await expectFailure(
    db,
    `insert into redirects (source_path, target_path, status_code) values ('/x', '/y', 200)`,
  );
  assert.match(message, /redirects_status_code_check/);

  // 反证：308 是合法值。
  const rows = await expectSuccess(
    db,
    `insert into redirects (source_path, target_path, status_code) values ('/p', '/q', 308)`,
  );
  assert.equal(rows, 1);
});

/* -------------------------------------------------------------------------- */
/* 9. entry_revisions 的 FK ON DELETE cascade                                   */
/* -------------------------------------------------------------------------- */

test('闸门 9：entry_revisions 的 FK 带 ON DELETE cascade（删 entries 行后 revisions 消失）', async () => {
  // 先确认迁移里真的写了 cascade，而不是靠外键默认的 no action。
  //
  // 注意：P4 之后 entry_revisions 有**两个**外键 —— `entry_id → entries`（cascade）
  // 与 `created_by → users`（set null）。所以不能再取「第一个 f」，必须按定义文本
  // 定位到 entry_id 那条，否则会拿 created_by 的 SET NULL 去匹配 CASCADE 而误报。
  const constraints = await listConstraints(db, 'entry_revisions');
  const fks = constraints.filter((c) => c.type === 'f');
  const fk = fks.find((c) => /FOREIGN KEY \(entry_id\)/.test(c.definition));
  assert.ok(fk, `entry_revisions 必须有 entry_id 外键，实际外键：${fks.map((f) => f.name).join(', ')}`);
  assert.match(fk.definition, /ON DELETE CASCADE/i);

  const entryId = await insertEntry(db, 'projects', 'cascade-probe');
  await expectSuccess(
    db,
    `insert into entry_revisions (entry_id, version, snapshot) values ($1, 1, '{}'::jsonb)`,
    [entryId],
  );

  const before = await db.query<{ n: number }>(
    `select count(*)::int as n from entry_revisions where entry_id = $1`,
    [entryId],
  );
  assert.equal(before.rows[0].n, 1);

  await expectSuccess(db, `delete from entries where id = $1`, [entryId]);

  const afterDelete = await db.query<{ n: number }>(
    `select count(*)::int as n from entry_revisions where entry_id = $1`,
    [entryId],
  );
  assert.equal(afterDelete.rows[0].n, 0, '删除 entries 行后子行必须被级联删除');
});

/* -------------------------------------------------------------------------- */
/* 10. entry_tags 复合主键                                                     */
/* -------------------------------------------------------------------------- */

test('闸门 10：entry_tags 复合主键生效（同 entry_id+tag_id 插两次必须失败）', async () => {
  const entryId = await insertEntry(db, 'goals', 'tags-probe');
  const tag = await db.query<{ id: string }>(
    `insert into tags (slug, name) values ('probe-tag', '探针标签') returning id`,
  );
  const tagId = tag.rows[0].id;

  await expectSuccess(
    db,
    `insert into entry_tags (entry_id, tag_id) values ($1, $2)`,
    [entryId, tagId],
  );

  const message = await expectFailure(
    db,
    `insert into entry_tags (entry_id, tag_id) values ($1, $2)`,
    [entryId, tagId],
  );
  assert.match(message, /entry_tags_entry_id_tag_id_pk|duplicate key/i);

  // 顺带验证 tags.slug 的唯一索引也是真的
  const dupTag = await expectFailure(db, `insert into tags (slug, name) values ('probe-tag', 'x')`);
  assert.match(dupTag, /tags_slug_idx/);
});

test('闸门 10b：entry_tags 有 tag_order 列（frontmatter 顺序可还原），默认 0 且不为空', async () => {
  const columns = await listColumns(db, 'entry_tags');
  assert.deepEqual(
    columns.map((column) => column.name),
    [...EXPECTED_ENTRY_TAG_COLUMNS],
    'entry_tags 列必须与 schema.ts 一致，且顺序不得漂移',
  );

  const byName = new Map(columns.map((column) => [column.name, column]));
  assert.equal(byName.get('tag_order')?.notNull, true, 'tag_order 必须 not null');
  assert.equal(byName.get('tag_order')?.dataType, 'integer', 'tag_order 必须是 integer');
  assert.match(String(byName.get('tag_order')?.defaultExpr), /0/, 'tag_order 默认值必须是 0');

  // 幂等导入依赖它：老数据 / 未显式给值的插入必须能落 0，而不是 NULL。
  const entryId = await insertEntry(db, 'goals', 'tags-order-default');
  const tag = await db.query<{ id: string }>(
    `insert into tags (slug, name) values ('order-default-tag', '顺序默认') returning id`,
  );
  await db.query(`insert into entry_tags (entry_id, tag_id) values ($1, $2)`, [
    entryId,
    tag.rows[0].id,
  ]);
  const row = await db.query<{ tag_order: number }>(
    `select tag_order from entry_tags where entry_id = $1`,
    [entryId],
  );
  assert.equal(row.rows[0].tag_order, 0, '不显式给值时必须落默认 0');
});

/* -------------------------------------------------------------------------- */
/* 11. 元数据完整性：CHECK / 索引名字与 schema 一致                             */
/* -------------------------------------------------------------------------- */

test('闸门 11：entries 的三条 CHECK 与两个索引名字与 schema.ts 一致', async () => {
  const checks = (await listConstraints(db, 'entries'))
    .filter((c) => c.type === 'c')
    .map((c) => c.name)
    .sort();
  assert.deepEqual(checks, [
    'entries_kind_check',
    'entries_publish_status_check',
    'entries_version_positive_check',
  ]);

  const indexes = await listIndexes(db, 'entries');
  const byName = new Map(indexes.map((index) => [index.name, index]));
  assert.ok(byName.has('entries_kind_slug_idx'));
  assert.equal(byName.get('entries_kind_slug_idx')?.unique, true);
  assert.ok(byName.has('entries_public_idx'));
  assert.equal(byName.get('entries_public_idx')?.unique, false);

  // entries_kind_check 的取值集合必须是 content-core 的 ENTRY_KINDS
  const kindCheck = (await listConstraints(db, 'entries')).find((c) => c.name === 'entries_kind_check');
  assert.match(kindCheck?.definition ?? '', /'blog'::text/);
  assert.match(kindCheck?.definition ?? '', /'diary'::text/);
  assert.match(kindCheck?.definition ?? '', /'projects'::text/);
  assert.match(kindCheck?.definition ?? '', /'goals'::text/);
});

/* -------------------------------------------------------------------------- */
/* 12. P4 认证表的结构契约                                                      */
/* -------------------------------------------------------------------------- */

test('闸门 12：P4 认证四表的结构契约（UUID 主键 / 复合主键 / 级联删除）', async () => {
  // users：uuid 主键（不是 Auth.js 默认的 text），email 唯一，github_login 唯一。
  const userColumns = await listColumns(db, 'users');
  const userId = userColumns.find((c) => c.name === 'id');
  assert.equal(userId?.dataType, 'uuid', 'users.id 必须是 uuid，否则 created_by 等外键加不上');
  assert.equal(userId?.notNull, true);
  assert.match(userId?.defaultExpr ?? '', /gen_random_uuid/);
  assert.ok(
    userColumns.some((c) => c.name === 'github_login'),
    'users 必须有 github_login —— 白名单 ADMIN_GITHUB_LOGIN 比的就是它',
  );

  const userIndexes = await listIndexes(db, 'users');
  const githubLoginIndex = userIndexes.find((i) => i.name === 'users_github_login_idx');
  assert.equal(githubLoginIndex?.unique, true, 'github_login 必须唯一');

  // accounts：复合主键 (provider, providerAccountId)，OAuth 账号靠它去重。
  const accountPk = (await listConstraints(db, 'accounts')).find((c) => c.type === 'p');
  assert.match(accountPk?.definition ?? '', /provider/);
  assert.match(accountPk?.definition ?? '', /providerAccountId|provider_account_id/);

  // sessions：sessionToken 做主键（Auth.js 按 token 查会话）。
  const sessionPk = (await listConstraints(db, 'sessions')).find((c) => c.type === 'p');
  assert.match(sessionPk?.definition ?? '', /sessionToken|session_token/);

  // verification_tokens：复合主键 (identifier, token)。
  const vtPk = (await listConstraints(db, 'verification_tokens')).find((c) => c.type === 'p');
  assert.match(vtPk?.definition ?? '', /identifier/);
  assert.match(vtPk?.definition ?? '', /token/);

  // 删用户时 accounts / sessions 必须跟着删（cascade），否则会留下孤儿会话。
  const accountFk = (await listConstraints(db, 'accounts')).find((c) => c.type === 'f');
  assert.match(accountFk?.definition ?? '', /ON DELETE CASCADE/);
  const sessionFk = (await listConstraints(db, 'sessions')).find((c) => c.type === 'f');
  assert.match(sessionFk?.definition ?? '', /ON DELETE CASCADE/);

  // 反向：删用户**不能**删内容。entries.created_by / audit_logs.actor_id 必须
  // 是 SET NULL，否则删掉一个管理员会把历史内容一起带走。
  for (const [table, constraintName] of [
    ['entries', 'entries_created_by_users_id_fk'],
    ['audit_logs', 'audit_logs_actor_id_users_id_fk'],
    ['entry_revisions', 'entry_revisions_created_by_users_id_fk'],
  ] as const) {
    const fk = (await listConstraints(db, table)).find((c) => c.name === constraintName);
    assert.ok(fk, `${table} 必须有外键 ${constraintName}`);
    assert.match(fk?.definition ?? '', /ON DELETE SET NULL/, `${constraintName} 必须是 SET NULL`);
  }
});

test('闸门 12b：认证四表的行为约束实测（email 唯一 / 会话级联删除）', async () => {
  // email 重复必须被拒。
  const email = `probe-${Date.now()}@example.invalid`;
  await expectSuccess(db, 'insert into users (email) values ($1)', [email]);
  const dupError = await expectFailure(db, 'insert into users (email) values ($1)', [email]);
  assert.match(dupError, /duplicate key|unique/i);

  // 建一条会话，再删用户，会话必须消失（cascade 真的生效，不只是 DDL 里写了）。
  const userId = (
    await db.query<{ id: string }>('select id from users where email = $1', [email])
  ).rows[0].id;
  await expectSuccess(
    db,
    `insert into sessions (session_token, user_id, expires)
     values ($1, $2, now() + interval '1 day')`,
    [`probe-token-${Date.now()}`, userId],
  );
  const before = await db.query<{ n: number }>('select count(*)::int as n from sessions where user_id = $1', [
    userId,
  ]);
  assert.equal(before.rows[0].n, 1);

  await expectSuccess(db, 'delete from users where id = $1', [userId]);
  const after = await db.query<{ n: number }>('select count(*)::int as n from sessions where user_id = $1', [
    userId,
  ]);
  assert.equal(after.rows[0].n, 0, '删用户后会话必须级联删除');
});

/* -------------------------------------------------------------------------- */
/* 决策点：gen_random_uuid 在 PGlite 里到底可不可用                             */
/* -------------------------------------------------------------------------- */

test('决策点：gen_random_uuid() 在 PGlite 可用（schema 不需要改契约）', async () => {
  const probe = await probeGenRandomUuid(db);
  const version = await probeServerVersion(db);

  assert.equal(
    probe.available,
    true,
    `gen_random_uuid() 不可用，schema 需要改用 uuid_generate_v4 或应用侧生成。` +
      `错误：${probe.error ?? '(none)'}；服务端：${version}`,
  );
  assert.match(probe.sample ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // v4 UUID 的第 13 位必须是 4，即版本号真的是 4
  assert.equal((probe.sample ?? '')[14], '4');
});
