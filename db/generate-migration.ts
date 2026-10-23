/**
 * 生成 SQL 迁移文件。
 *
 * 为什么不用 `drizzle-kit generate` CLI：
 * 本机（Windows + 受限 shell）下 drizzle-kit 的 CLI 会 `spawn EPERM`（它内部起子进程）。
 * 因此改用它导出的编程 API（`drizzle-kit/api`），在**本进程内**完成：
 *   generateDrizzleJson（把 schema.ts 编译成 schema json）
 *   → generateMigration（与上一版 json 比对，产出 SQL 语句数组）
 *   → 我们自己拼成 Drizzle 标准格式的 .sql + meta。
 *
 * 用法：node db/generate-migration.ts [迁移名]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');
const metaDir = join(migrationsDir, 'meta');
const schemaPath = join(here, 'schema.ts');

/** 链式快照的起始 id（drizzle 约定）。 */
const ZERO_ID = '00000000-0000-0000-0000-000000000000';

/** 上一次迁移的快照与 id。 */
function readPrevSnapshot(): { snapshot: Record<string, unknown>; id: string } | null {
  if (!existsSync(metaDir)) return null;
  const files = readdirSync(metaDir)
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort();
  if (files.length === 0) return null;
  const last = files[files.length - 1];
  const snapshot = JSON.parse(readFileSync(join(metaDir, last), 'utf8')) as Record<string, unknown>;
  return { snapshot, id: String(snapshot.id ?? ZERO_ID) };
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? 'init';

  // Node 24 原生 type stripping 可直接 import .ts。
  const mod = (await import(`file://${schemaPath.replace(/\\/g, '/')}`)) as Record<string, unknown>;

  const prevInfo = readPrevSnapshot();
  const prevId = prevInfo?.id ?? ZERO_ID;

  // 首次迁移：与「空 schema」比对。空的 PgSchema 不是 `{}`，
  // 必须由 generateDrizzleJson({}) 生成符合 drizzle 校验的形状。
  const emptyPrev = generateDrizzleJson({}, ZERO_ID) as unknown as Record<string, unknown>;

  const current = generateDrizzleJson(mod, prevId);
  const statements = await generateMigration(
    (prevInfo?.snapshot ?? emptyPrev) as never,
    current as never,
  );

  if (statements.length === 0) {
    console.log('[migrate:generate] schema 无变化，未生成新迁移。');
    return;
  }

  mkdirSync(metaDir, { recursive: true });

  const existing = existsSync(migrationsDir)
    ? readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))
    : [];
  const nextIdx = existing.length;
  const tag = String(nextIdx).padStart(4, '0');

  const fileName = `${tag}_${name}.sql`;
  const header = [
    `-- 迁移 ${tag}_${name}`,
    '-- 由 db/generate-migration.ts 生成，请勿手工编辑。',
    '-- 对应方案：动态网站平台化执行方案.md §6.1~§6.6（7 张业务表）',
    '',
    '',
  ].join('\n');
  const sqlBody = statements.join('\n--> statement-breakpoint\n');
  writeFileSync(join(migrationsDir, fileName), `${header}${sqlBody}\n`, 'utf8');

  // 快照要写回「与本次 SQL 对应的 schema json」，供下次 diff 使用。
  writeFileSync(
    join(metaDir, `${tag}_snapshot.json`),
    JSON.stringify(current, null, 2),
    'utf8',
  );

  const journalPath = join(metaDir, '_journal.json');
  const journal = existsSync(journalPath)
    ? (JSON.parse(readFileSync(journalPath, 'utf8')) as {
        version: string;
        dialect: string;
        entries: unknown[];
      })
    : { version: '7', dialect: 'postgresql', entries: [] as unknown[] };
  journal.entries.push({
    idx: nextIdx,
    version: '7',
    when: Date.now(),
    tag: `${tag}_${name}`,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8');

  console.log(`[migrate:generate] 已生成 db/migrations/${fileName}（${statements.length} 条语句）`);
  for (const s of statements) {
    console.log('  · ' + s.split('\n')[0].slice(0, 120));
  }
}

main().catch((error) => {
  console.error('[migrate:generate] 失败：', error);
  process.exitCode = 1;
});
