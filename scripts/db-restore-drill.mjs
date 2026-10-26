/**
 * 真实恢复演练：删掉真数据 → 用备份恢复 → 断言逐字节回来了。
 *
 * 这是「回滚演练」里数据库那一类的核心证据。只读/幂等测试证明不了
 * 「丢了能捞回来」，必须真删。
 *
 * 选择删除对象的原则：删**最危险**的那种 —— 有级联的父行。
 * 删 tags 一行会级联删掉 entry_tags 里对应的关联行，正好同时验证
 * 「父行恢复」与「子行恢复」两件事。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");

function loadEnv() {
  const p = join(REPO_ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadEnv();

const backupFile = process.argv[2];
if (!backupFile) {
  console.error("用法：node scripts/db-restore-drill.mjs <backup.json>");
  process.exit(1);
}
const payload = JSON.parse(readFileSync(resolvePath(REPO_ROOT, backupFile), "utf8"));

const { default: postgres } = await import("postgres");
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {}, connect_timeout: 15 });

const counts = async () => {
  const out = {};
  for (const t of ["entries", "tags", "entry_tags"]) {
    const r = await sql.unsafe(`select count(*)::int as n from "${t}"`);
    out[t] = r[0].n;
  }
  return out;
};

const expected = payload.meta.counts;
let failures = 0;
const check = (label, actual, want) => {
  const ok = actual === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}：实际 ${actual} / 期望 ${want}`);
};

// ── 0. 起始状态 ────────────────────────────────────────────────────────────
console.log("=== 0. 起始状态（应等于备份）===");
const before = await counts();
for (const t of ["entries", "tags", "entry_tags"]) check(`${t} 行数`, before[t], expected[t]);

// ── 1. 选一个被 entry_tags 引用的 tag，记下它和它的关联行 ────────────────
const victim = await sql`
  select t.id, t.slug, t.name, count(et.entry_id)::int as links
  from tags t join entry_tags et on et.tag_id = t.id
  group by t.id, t.slug, t.name
  order by links desc, t.slug
  limit 1
`;
if (victim.length === 0) {
  console.error("没有可删的 tag，演练无法进行");
  await sql.end({ timeout: 5 });
  process.exit(1);
}
const v = victim[0];
console.log(`\n=== 1. 选定受害行 ===`);
console.log(`  tag id=${v.id} slug=${v.slug} name=${v.name} 关联 ${v.links} 篇内容`);

const linksBefore = await sql`select entry_id, tag_order from entry_tags where tag_id = ${v.id} order by entry_id`;
console.log(`  关联行明细：${linksBefore.map((l) => `${l.entry_id.slice(0, 8)}@${l.tag_order}`).join(", ")}`);

// ── 2. 真删（级联会带走 entry_tags 的关联行）──────────────────────────────
console.log("\n=== 2. 真删父行（依赖 on delete cascade）===");
await sql`delete from tags where id = ${v.id}`;
const afterDelete = await counts();
console.log(`  删除后：tags=${afterDelete.tags}（原 ${before.tags}），entry_tags=${afterDelete.entry_tags}（原 ${before.entry_tags}）`);
const cascadeWorked = afterDelete.entry_tags === before.entry_tags - v.links;
console.log(`  ${cascadeWorked ? "✓" : "✗"} 级联删除生效：少了 ${before.entry_tags - afterDelete.entry_tags} 行，应为 ${v.links}`);
if (!cascadeWorked) failures++;
if (afterDelete.tags !== before.tags - 1) {
  console.log(`  ✗ tags 应少 1 行`);
  failures++;
}

// ── 3. 用备份恢复 ──────────────────────────────────────────────────────────
console.log("\n=== 3. 用备份恢复 ===");
const { spawnSync } = await import("node:child_process");
const res = spawnSync(process.execPath, ["scripts/db-backup.mjs", "restore", backupFile], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  stdio: "inherit",
});
if (res.status !== 0) {
  console.log(`  ✗ restore 退出码 ${res.status}`);
  failures++;
}

// ── 4. 断言逐行回来了 ──────────────────────────────────────────────────────
console.log("\n=== 4. 恢复后逐项比对 ===");
const after = await counts();
for (const t of ["entries", "tags", "entry_tags"]) check(`${t} 行数`, after[t], expected[t]);

const restoredTag = await sql`select id, slug, name from tags where id = ${v.id}`;
check(`tag 行本身回来了`, restoredTag.length, 1);
if (restoredTag.length === 1) {
  check(`slug 一致`, restoredTag[0].slug === v.slug ? 1 : 0, 1);
  check(`name 一致`, restoredTag[0].name === v.name ? 1 : 0, 1);
}

const linksAfter = await sql`select entry_id, tag_order from entry_tags where tag_id = ${v.id} order by entry_id`;
check(`关联行数一致`, linksAfter.length, linksBefore.length);
const sameLinks =
  linksAfter.length === linksBefore.length &&
  linksAfter.every((l, i) => l.entry_id === linksBefore[i].entry_id && l.tag_order === linksBefore[i].tag_order);
check(`关联行逐条一致（含 tag_order）`, sameLinks ? 1 : 0, 1);

await sql.end({ timeout: 5 });

console.log(`\n${failures === 0 ? "✅ 数据库恢复演练通过：删掉的数据被完整捞回" : `❌ ${failures} 项不符合预期`}`);
process.exit(failures === 0 ? 0 : 1);
