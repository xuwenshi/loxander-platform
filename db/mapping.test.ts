/**
 * `db/mapping.ts` 的单元测试 + 对 10 个真实文件的整体验收。
 *
 * 为什么用 `node:test` 而不是 vitest：
 *   本机沙箱禁止管道 stdio 子进程（记录 §6.3），vitest 无论 `--pool=forks` 还是
 *   `--pool=threads` 都会 `spawn EPERM`（threads 模式死在 vite 的
 *   `optimizeSafeRealPathSync`）。`node --test` 默认也 fork 子进程，同样 EPERM；
 *   只有 `--test-isolation=none` 能跑。
 *   因此本文件**自己装 resolve hook**（补 `.ts` 后缀，因为
 *   `@loxander/content-core` 的内部 import 是无扩展名的），然后直接
 *   `node db/mapping.test.ts` 执行 —— 不走 `--test`，就不触发子进程。
 *
 * 运行方式（仓库根）：
 *   node db/mapping.test.ts
 *   # 或：node --test-isolation=none db/mapping.test.ts
 */

/* -------------------------------------------------------------------------- */
/* resolve hook 引导（见文件头注释）                                            */
/* -------------------------------------------------------------------------- */

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const isRelative =
        specifier.startsWith('.') ||
        specifier.startsWith('/') ||
        specifier.startsWith('file:');
      if (!isRelative) throw error;
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
      const bare = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier;
      const target = resolvePath(dirname(parent), bare);
      for (const ext of ['.ts', '.tsx']) {
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

import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { mapEntry, readCoverDimensions, renderOptionsForKind, DROPPED_FRONTMATTER_FIELDS } =
  await import('./mapping');

type EntryKind = import('@loxander/content-core').EntryKind;
type MapContext = import('./mapping').MapContext;

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const CONTENT_DIR = join(WEB_ROOT, 'content');
const PUBLIC_DIR = join(WEB_ROOT, 'public');

/** 固定时间源，让 projects/goals 的 published_at 可断言。 */
const FIXED_NOW = () => new Date('2026-10-22T00:00:00.000Z');

const CTX: MapContext = { publicDir: PUBLIC_DIR, now: FIXED_NOW };

/** 把失败结果收窄成成功结果，失败时带出 blocking 原文方便定位。 */
function expectOk(result: ReturnType<typeof mapEntry>) {
  if (!result.ok) {
    const detail = result.issues
      .map((issue) => (issue.field ? `${issue.field}: ${issue.message}` : issue.message))
      .join('；');
    assert.fail(`期望映射成功，实际 blocking：${detail}`);
  }
  return result;
}

function expectFail(result: ReturnType<typeof mapEntry>) {
  assert.equal(result.ok, false, '期望映射失败，实际成功');
  if (result.ok) throw new Error('unreachable');
  return result;
}

/* -------------------------------------------------------------------------- */
/* 1. 逐分区的映射契约                                                         */
/* -------------------------------------------------------------------------- */

test('blog：title/description → title/summary，display_date 与东八区零点', () => {
  const raw = [
    '---',
    'title: "标题"',
    'description: "摘要"',
    'date: 2026-08-26',
    'category: "数据科学"',
    'tags: ["A", "B"]',
    '---',
    '',
    '正文',
  ].join('\n');

  const result = expectOk(mapEntry('blog', 'demo', raw, CTX));

  assert.equal(result.row.kind, 'blog');
  assert.equal(result.row.slug, 'demo');
  assert.equal(result.row.title, '标题');
  assert.equal(result.row.summary, '摘要', 'blog 的 summary 来自 description');
  assert.equal(result.row.display_date, '2026-08-26');
  // 东八区零点 = UTC 前一天 16:00。
  assert.equal(result.row.published_at?.toISOString(), '2026-08-25T16:00:00.000Z');
  assert.equal(result.row.publish_status, 'published');
  assert.equal(result.row.featured, false);
  assert.equal(result.row.sort_order, 999);
  assert.equal(result.row.version, 1);
  assert.equal(result.row.body_md, '正文');
  assert.deepEqual(result.row.data, { category: '数据科学' });
});

test('blog：draft: true → publish_status=draft', () => {
  const raw = '---\ntitle: T\ndescription: D\ndate: 2026-08-26\ndraft: true\n---\n正文';
  const result = expectOk(mapEntry('blog', 'demo', raw, CTX));
  assert.equal(result.row.publish_status, 'draft');
});

test('blog：category 缺失时由 schema 兜底成「未分类」', () => {
  const raw = '---\ntitle: T\ndescription: D\ndate: 2026-08-26\n---\n正文';
  const result = expectOk(mapEntry('blog', 'demo', raw, CTX));
  assert.equal(result.row.data.category, '未分类');
});

test('blog：cover 存在时从 SVG 读出 coverWidth/coverHeight 写进 data', () => {
  const raw =
    '---\ntitle: T\ndescription: D\ndate: 2026-09-10\ncover: "/images/langgraph-flow.svg"\n---\n正文';
  const result = expectOk(mapEntry('blog', 'demo', raw, CTX));
  assert.deepEqual(result.row.data, {
    category: '未分类',
    cover: '/images/langgraph-flow.svg',
    coverWidth: 900,
    coverHeight: 460,
  });
});

test('blog：cover 指向不存在的文件 → 只有 warning，不写尺寸键', () => {
  const raw =
    '---\ntitle: T\ndescription: D\ndate: 2026-09-10\ncover: "/images/does-not-exist.svg"\n---\n正文';
  const result = expectOk(mapEntry('blog', 'demo', raw, CTX));
  assert.equal(result.row.data.coverWidth, undefined);
  assert.equal(result.row.data.coverHeight, undefined);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].field, 'cover');
});

test('diary：summary 来自 frontmatter 的 summary（不是 description）', () => {
  const raw = [
    '---',
    'date: 2026-10-12',
    'title: "day01"',
    'summary: "一句话摘要"',
    'mood: "平静"',
    '---',
    '正文',
  ].join('\n');

  const result = expectOk(mapEntry('diary', 'week01', raw, CTX));

  assert.equal(result.row.title, 'day01');
  assert.equal(result.row.summary, '一句话摘要');
  assert.equal(result.row.display_date, '2026-10-12');
  assert.equal(result.row.published_at?.toISOString(), '2026-10-11T16:00:00.000Z');
  assert.equal(result.row.sort_order, 999);
  // diary 的 data 只留 `{ mood? }`：`date` 已提升为 entries.display_date 列，
  // 同一事实不再存两份（否则 P4 后台改日期必然漂移）。
  assert.deepEqual(result.row.data, { mood: '平静' });
});

test('diary：mood 缺失时 data 为空对象（date 已在 display_date 列）', () => {
  const raw = '---\ndate: 2026-10-12\ntitle: T\nsummary: S\n---\n正文';
  const result = expectOk(mapEntry('diary', 'd', raw, CTX));
  assert.deepEqual(result.row.data, {});
  assert.equal(result.row.display_date, '2026-10-12', '日期只在列上，不在 data 里');
});

test('projects：name → title，description → summary，featured/order 提升为列', () => {
  const raw = [
    '---',
    'name: "项目名"',
    'description: "项目摘要"',
    'techStack: ["Python", "RAG"]',
    'status: "in-progress"',
    'period: "2026.07 - 至今"',
    'role: "架构"',
    'github: "https://github.com/x"',
    'article: "some-blog"',
    'featured: true',
    'order: 3',
    '---',
    '正文',
  ].join('\n');

  const result = expectOk(
    mapEntry('projects', 'p', raw, { ...CTX, knownBlogSlugs: ['some-blog'] }),
  );

  assert.equal(result.row.title, '项目名', 'projects 用 name 而不是 title');
  assert.equal(result.row.summary, '项目摘要');
  assert.equal(result.row.featured, true);
  assert.equal(result.row.sort_order, 3);
  assert.equal(result.row.publish_status, 'published');
  assert.equal(result.row.display_date, null, 'projects 没有 display_date');
  assert.equal(result.row.published_at?.toISOString(), '2026-10-22T00:00:00.000Z');
  assert.deepEqual(result.row.data, {
    techStack: ['Python', 'RAG'],
    status: 'in-progress',
    period: '2026.07 - 至今',
    role: '架构',
    github: 'https://github.com/x',
    article: 'some-blog',
  });
});

test('projects：article 指向不存在的 blog slug → warning 而非 blocking', () => {
  const raw = [
    '---',
    'name: P',
    'description: D',
    'techStack: []',
    'status: "active"',
    'article: "nope"',
    '---',
    '正文',
  ].join('\n');

  const result = expectOk(mapEntry('projects', 'p', raw, { ...CTX, knownBlogSlugs: ['other'] }));
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].field, 'article');
});

test('goals：summary 强制为空串，milestones/progress 进 data', () => {
  const raw = [
    '---',
    'title: "示例目标"',
    'horizon: "short"',
    'status: "planned"',
    'progress: 0',
    'period: "2026 Q4"',
    'order: 1',
    'milestones:',
    '  - title: "里程碑一"',
    '    done: false',
    '---',
    '正文',
  ].join('\n');

  const result = expectOk(mapEntry('goals', 'g', raw, CTX));

  assert.equal(result.row.title, '示例目标');
  assert.equal(result.row.summary, '');
  assert.equal(result.row.sort_order, 1);
  assert.equal(result.row.display_date, null);
  assert.deepEqual(result.row.data, {
    horizon: 'short',
    status: 'planned',
    progress: 0,
    milestones: [{ title: '里程碑一', done: false }],
    period: '2026 Q4',
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 失败路径                                                                  */
/* -------------------------------------------------------------------------- */

test('blocking：缺 title 时返回 ok=false 并带出字段名', () => {
  const raw = '---\ndescription: D\ndate: 2026-08-26\n---\n正文';
  const failed = expectFail(mapEntry('blog', 'demo', raw, CTX));
  assert.ok(failed.issues.length > 0);
  assert.ok(
    failed.issues.some((issue) => issue.field === 'title'),
    `期望 title 级 blocking，实际：${JSON.stringify(failed.issues)}`,
  );
});

test('blocking：progress 越界（130）在 content-core 层就被拦住', () => {
  const raw =
    '---\ntitle: T\nhorizon: "short"\nstatus: "planned"\nprogress: 130\nmilestones: []\n---\n正文';
  const failed = expectFail(mapEntry('goals', 'g', raw, CTX));
  assert.ok(failed.issues.some((issue) => issue.field === 'progress'));
});

test('slug 非法时直接失败，不做任何猜测性修复', () => {
  const raw = '---\ntitle: T\ndescription: D\ndate: 2026-08-26\n---\n正文';
  const failed = expectFail(mapEntry('blog', 'bad/../slug', raw, CTX));
  assert.equal(failed.issues[0].field, 'slug');
});

test('非法日期 2026-13-45 会被 YAML 先行归一成 2027-02-14（记录事实，不是缺陷）', () => {
  // 实测：gray-matter/js-yaml 把裸日期 `2026-13-45` 当 Date 解析，
  // 且它会**静默滚动**到 2027-02-14（`matter(raw).data.date` 已是 Date 对象）。
  // 等 content-core 的 zDate 拿到手时，输入早就是合法的 2027-02-14 了，
  // 所以「日期越界」在映射层根本不可能被挡住 —— 这是 js-yaml 的既有行为，
  // 站点侧（apps/web/src/lib/posts.ts:105 同样走 matter）一直如此，P2 不改它。
  const raw = '---\ntitle: T\ndescription: D\ndate: 2026-13-45\n---\n正文';
  const result = expectOk(mapEntry('blog', 'demo', raw, CTX));
  assert.equal(result.row.display_date, '2027-02-14');
});

/* -------------------------------------------------------------------------- */
/* 3. 纯函数性质                                                                */
/* -------------------------------------------------------------------------- */

test('纯函数：同样输入两次得到完全相同的行（now 已注入）', () => {
  const raw = '---\nname: P\ndescription: D\ntechStack: ["x"]\nstatus: "active"\n---\n正文';
  const a = expectOk(mapEntry('projects', 'p', raw, CTX));
  const b = expectOk(mapEntry('projects', 'p', raw, CTX));
  assert.deepEqual(a.row, b.row);
});

test('readingTime 不入库：行对象里不存在该键', () => {
  const raw = '---\ntitle: T\ndescription: D\ndate: 2026-08-26\n---\n正文';
  const result = expectOk(mapEntry('blog', 'demo', raw, CTX));
  assert.equal('readingTime' in result.row, false);
  assert.equal('reading_time' in result.row, false);
});

test('body_html 不在这里生成：映射只产出 body_md', () => {
  const raw = '---\ntitle: T\ndescription: D\ndate: 2026-08-26\n---\n正文';
  const result = expectOk(mapEntry('blog', 'demo', raw, CTX));
  assert.equal('body_html' in result.row, false);
  assert.equal(result.row.body_md, '正文');
});

test('DROPPED_FRONTMATTER_FIELDS 如实声明了未入库字段', () => {
  assert.deepEqual(DROPPED_FRONTMATTER_FIELDS.blog, ['tags']);
  assert.deepEqual(DROPPED_FRONTMATTER_FIELDS.diary, ['tags']);
  assert.deepEqual(DROPPED_FRONTMATTER_FIELDS.projects, []);
  assert.deepEqual(DROPPED_FRONTMATTER_FIELDS.goals, []);
});

/* -------------------------------------------------------------------------- */
/* 3.5 渲染选项：body_html 必须与站点渲染态逐字节一致                            */
/* -------------------------------------------------------------------------- */

test('renderOptionsForKind：只有 goals 下移两级，其余为 0', () => {
  assert.deepEqual(renderOptionsForKind('goals'), { headingOffset: 2 });
  assert.deepEqual(renderOptionsForKind('blog'), { headingOffset: 0 });
  assert.deepEqual(renderOptionsForKind('projects'), { headingOffset: 0 });
  assert.deepEqual(renderOptionsForKind('diary'), { headingOffset: 0 });
});

test('真实文件渲染：goals 的标题是 h4，blog 的是 h2', async () => {
  const { renderMarkdown } = await import('@loxander/markdown');

  const goalRaw = readFileSync(join(CONTENT_DIR, 'goals', '01-example-short.md'), 'utf8');
  const goal = expectOk(mapEntry('goals', '01-example-short', goalRaw, CTX));
  const goalHtml = await renderMarkdown(goal.body, renderOptionsForKind('goals'));
  // 正文里的 `## 为什么定这个目标` 必须变成 h4（站点 goals.ts:88 的 headingOffset: 2）。
  assert.ok(goalHtml.includes('<h4 id='), `goals 应产出 <h4 id=，实际开头：${goalHtml.slice(0, 120)}`);
  assert.equal(goalHtml.includes('<h2 id='), false, 'goals 不允许残留 h2 标题');

  const postRaw = readFileSync(join(CONTENT_DIR, 'blog', 'langgraph-rag-workflow.md'), 'utf8');
  const post = expectOk(mapEntry('blog', 'langgraph-rag-workflow', postRaw, CTX));
  const postHtml = await renderMarkdown(post.body, renderOptionsForKind('blog'));
  assert.ok(postHtml.includes('<h2 id='), `blog 应产出 <h2 id=，实际开头：${postHtml.slice(0, 120)}`);
  assert.equal(postHtml.includes('<h4 id='), false, 'blog 不做标题下移');

  // 同一份 goal 正文用 offset 0 渲染时是 h2 —— 反证 headingOffset 确实生效。
  const unmoved = await renderMarkdown(goal.body, renderOptionsForKind('blog'));
  assert.ok(unmoved.includes('<h2 id='), 'offset 0 时 goals 正文应为 h2');
  assert.notEqual(goalHtml, unmoved);
});

/* -------------------------------------------------------------------------- */
/* 4. readCoverDimensions                                                      */
/* -------------------------------------------------------------------------- */

test('readCoverDimensions：解析公开 SVG 的 width/height', () => {
  assert.deepEqual(readCoverDimensions(PUBLIC_DIR, '/images/rag-pipeline.svg'), {
    width: 880,
    height: 420,
  });
});

test('readCoverDimensions：非 .svg 约定 / 文件不存在 一律返回 null', () => {
  assert.equal(readCoverDimensions(PUBLIC_DIR, 'images/a.svg'), null, '必须 / 开头');
  assert.equal(readCoverDimensions(PUBLIC_DIR, '/images/a.png'), null);
  assert.equal(readCoverDimensions(PUBLIC_DIR, undefined), null);
  assert.equal(readCoverDimensions(PUBLIC_DIR, '/images/missing.svg'), null);
});

/* -------------------------------------------------------------------------- */
/* 5. 对 10 个真实文件的整体验收（这就是 dry-run 的底料）                        */
/* -------------------------------------------------------------------------- */

test('真实内容：10 个文件全部映射成功，四类计数 4/3/1/2，零 blocking', () => {
  const kinds: readonly EntryKind[] = ['blog', 'diary', 'projects', 'goals'];
  const knownBlogSlugs = readdirSync(join(CONTENT_DIR, 'blog'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''));

  const counts: Record<string, number> = {};
  const warnings: string[] = [];

  for (const kind of kinds) {
    const dir = join(CONTENT_DIR, kind);
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const slug = name.replace(/\.md$/, '');
      const raw = readFileSync(join(dir, name), 'utf8');
      const result = mapEntry(kind, slug, raw, {
        publicDir: PUBLIC_DIR,
        knownBlogSlugs,
        now: FIXED_NOW,
      });
      if (!result.ok) {
        assert.fail(`${kind}/${name} 出现 blocking：${JSON.stringify(result.issues)}`);
      }
      counts[kind] = (counts[kind] ?? 0) + 1;
      for (const issue of result.warnings) {
        warnings.push(`${kind}/${name} ${issue.field ?? ''}: ${issue.message}`);
      }
    }
  }

  assert.deepEqual(counts, { blog: 4, diary: 1, projects: 3, goals: 2 });
  assert.deepEqual(warnings, [], '真实内容不允许产生 warning');
});

test('真实内容：每行的必填列都非空且类型正确', () => {
  const raw = readFileSync(join(CONTENT_DIR, 'blog', 'langgraph-rag-workflow.md'), 'utf8');
  const result = expectOk(mapEntry('blog', 'langgraph-rag-workflow', raw, CTX));

  assert.ok(result.row.title.length > 0);
  assert.ok(result.row.summary.length > 0);
  assert.ok(result.row.body_md.length > 0);
  assert.ok(result.row.body_md.startsWith('最初我的检索问答'), 'frontmatter 已被剔除');
  assert.ok(result.row.published_at instanceof Date);
  assert.match(String(result.row.display_date), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof result.row.data, 'object');
});

/* -------------------------------------------------------------------------- */
/* 6. 落库形状验证（pglite 内存库，不连真 Postgres）                             */
/* -------------------------------------------------------------------------- */

test('pglite：迁移建表成功，同一行 upsert 两次仍只有 1 行且 version 不变', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { sql } = await import('drizzle-orm');
  const { entries } = await import('./schema');

  const pg = new PGlite();
  try {
    // 直接执行已生成的 DDL，确保「代码里的 schema」与「迁移文件」一致可建表。
    const migration = readFileSync(join(HERE, 'migrations', '0000_init.sql'), 'utf8');
    const statements = migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await pg.exec(statement);

    const db = drizzle(pg);

    const raw = readFileSync(join(CONTENT_DIR, 'blog', 'rag-chunking-strategies.md'), 'utf8');
    const mapped = expectOk(mapEntry('blog', 'rag-chunking-strategies', raw, CTX));
    const values = { ...mapped.row, body_html: '<p>cached</p>' };

    // 与 db/import.ts:340-350 的 SET 子句保持同一份形状（尤其 published_at 的 coalesce），
    // 否则这条集成测试就测不到真正上线的幂等语义。
    const conflictSet = {
      title: sql`excluded.title`,
      summary: sql`excluded.summary`,
      body_md: sql`excluded.body_md`,
      body_html: sql`excluded.body_html`,
      publish_status: sql`excluded.publish_status`,
      featured: sql`excluded.featured`,
      sort_order: sql`excluded.sort_order`,
      published_at: sql`coalesce(${entries.published_at}, excluded.published_at)`,
      display_date: sql`excluded.display_date`,
      data: sql`excluded.data`,
      updated_at: sql`now()`,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await db.insert(entries).values(values).onConflictDoUpdate({
        target: [entries.kind, entries.slug],
        set: conflictSet,
      });
    }

    const stored = await db.select().from(entries);
    assert.equal(stored.length, 1, '幂等：两次 upsert 只有 1 行');
    assert.equal(stored[0].version, 1, '导入不碰 version（后台乐观锁）');
    assert.equal(stored[0].display_date, '2026-09-24');
    assert.equal(stored[0].published_at?.toISOString(), '2026-09-23T16:00:00.000Z');
    assert.equal(stored[0].publish_status, 'published');
    assert.equal((stored[0].data as { coverWidth?: number }).coverWidth, 880);

    // 决策 1 的直接守护：第二次 upsert 故意带一个**不同的** published_at，
    // coalesce 必须让库里保留首次写入的值 —— 否则每次重跑都会刷新
    // projects/goals 的时间戳（它们没有日期字段，取导入时刻），打脏 entries_public_idx。
    await db.insert(entries).values({ ...values, published_at: new Date('2030-01-01T00:00:00Z') }).onConflictDoUpdate({
      target: [entries.kind, entries.slug],
      set: conflictSet,
    });
    const after = await db.select().from(entries);
    assert.equal(after.length, 1);
    assert.equal(
      after[0].published_at?.toISOString(),
      '2026-09-23T16:00:00.000Z',
      'published_at 幂等：库里已有值时重跑不得覆盖'
    );
  } finally {
    await pg.close();
  }
});
