import "server-only";

import { eq, ilike, or, sql } from "drizzle-orm";
import type { EntryKind } from "@loxander/content-core";

import { entries, entryRevisions } from "../../../../../db/schema";
import { getAdminDb } from "../admin/db";

/**
 * 图片引用检查：这张图还被哪些内容用着？
 *
 * ── 为什么删除前必须查这个 ──────────────────────────────────────────
 * 图片与内容之间**没有外键**。正文里写的是一段文本（`/media/x.png` 或一个
 * Blob 绝对 URL），数据库不知道这段文本指向 `media` 表的哪一行。所以「删除
 * 图片」如果只看 `media` 表，会把仍然被文章引用的图删掉，线上立刻出现破图，
 * 而且**没有任何回滚手段**（图在对象存储里已经没了，正文里的字符串还在）。
 * 因此删除前的引用检查不是「体验优化」，是正确性要求。
 *
 * ── 为什么查全状态，不过滤 publish_status ────────────────────────────
 * 直觉是「只有已发布的文章才需要图」，但草稿同样要：一张图被三篇草稿引用时
 * 删掉它，作者下次打开发布时会看到破图，而那时已经找不到这张图了。
 * `archived` 也一样 —— 归档可以恢复。所以这里**故意**不加任何状态过滤，
 * 宁可多拦一次删除。
 *
 * ── 为什么先在 SQL 粗筛、再在 JS 精确判断 ────────────────────────────
 * 精确匹配需要「把正文里的每个图片地址归一化成 pathname 再比对」，这个逻辑
 * 用 SQL 表达要么写一堆 `regexp_replace`（不可读、无法单测），要么把全表
 * `body_md` 读进内存（内容多了就是上千篇 × 几十 KB）。折中：SQL 用
 * `ILIKE '%<pathname>%'` 粗筛（能走顺序扫描但至少不传回无关行），
 * JS 里再用同一份归一化逻辑确认。粗筛只可能**多**捞，不可能漏 —— 因为
 * 任何一处精确命中，其文本里必然包含 pathname 这段子串。
 *
 * ── 为什么还要扫 `entry_revisions.snapshot` ──────────────────────────
 * 这条是 P5 审计（`P5审计报告.md` 四-2）发现的缺口，此前漏了。
 * `entry_revisions.snapshot` 存的是「可回滚的全部业务字段」（`db/schema.ts:205`），
 * 里面包含 `body_md` 与 `data`。如果只扫 `entries` 当前行：
 * 某篇文章改过图（旧版正文里引用了图 X，新版换成了图 Y）→ 当前行不含 X →
 * 删掉 X → 作者回滚到旧版本 → 立刻破图，而图已经找不回来了。
 * 所以历史快照里的引用同样是「还在用」。
 *
 * 判定方式是**字符串包含**（不是精确解析）：快照是 JSON，里面 `body_md`
 * 与 `data.cover` 的图片地址都是 JSON 字符串字面量，pathname 必然原样出现在
 * 序列化文本里（`/` 不需要转义）。粗筛能多捞（比如某个 `change_note` 里
 * 提到同一个路径），多捞的代价只是「多拦一次删除」，方向是安全的。
 */

/** 命中的字段名。写成字符串而不是枚举，是为了让人一眼看出方位。 */
export interface MediaReference {
  kind: EntryKind;
  slug: string;
  title: string;
  /** 命中的字段，如 `data.cover` / `body_md`。同一篇文章两处都命中时会出现两条。 */
  field: string;
}

/**
 * 把一个「可能是 URL、可能是相对路径」的字符串归一化成 pathname 候选集合。
 *
 * 需要这样做的原因很具体：同一张图在仓库里会以不同形态出现 ——
 * ① `media/2026/10/x.png`（`media` 表的 `path` 列）；
 * ② `/media/2026/10/x.png`（本地兜底的 `url` 列）；
 * ③ `https://xxx.public.blob.vercel-storage.com/media/2026/10/x.png`（Blob 的 `url`）。
 * 三者指向同一个文件，但字符串完全不相等。归一化的唯一目的就是让它们相等。
 *
 * 去掉 query / hash 是因为 Blob URL 可能带签名参数；去掉前导斜杠是为了让
 * 绝对路径与相对路径进入同一个命名空间。
 */
function pathnamesOf(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const values = new Set<string>();
  const add = (value: string): void => {
    const normalized = value.replace(/^\/+/, "");
    if (normalized.length > 0) values.add(normalized);
  };

  add(trimmed);
  add(trimmed.split(/[?#]/)[0] ?? trimmed);

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      add(new URL(trimmed).pathname);
    } catch {
      // URL 解析失败（例如手写的畸形绝对地址）时保留上面的原始候选即可。
    }
  }

  return [...values];
}

/**
 * 转义 LIKE 模式里的特殊字符。
 *
 * Postgres 的 `LIKE` 默认以反斜杠为转义符，所以 `%`、`_`、`\` 三者要加反斜杠。
 * 我们的文件名是「时间戳 + 随机 hex + 扩展名」，天然不含这些字符；但调用方未来
 * 可能传入用户给的 path，**这里不能假设输入干净**。
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 从 Markdown 正文里抠出所有图片地址：`![alt](path)` 与 `<img src="path">`。 */
function extractImageSources(markdown: string): string[] {
  const found: string[] = [];

  // `![alt](url "title")` —— 只取括号里第一个非空格 token，忽略可选的 title。
  const markdownImage = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?/g;
  for (let match = markdownImage.exec(markdown); match; match = markdownImage.exec(markdown)) {
    found.push(match[1]);
  }

  // `<img src="...">`：属性顺序不固定，所以只匹配 `src=` 本身，不要求它紧跟标签名。
  const htmlImage = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (let match = htmlImage.exec(markdown); match; match = htmlImage.exec(markdown)) {
    found.push(match[1]);
  }

  return found;
}

/**
 * 找出所有还在引用这张图的内容条目。
 *
 * 四条扫描路径对应四种历史写法：
 * ① `entries.data->>'cover'` —— 列表页封面（P2 起封面走 jsonb，不进正文）；
 * ② Markdown 的 `![alt](path)` —— 正文插图的主要写法；
 * ③ 裸 HTML 的 `<img src="path">` —— 当需要在图外加类名/尺寸时作者会直接写 HTML；
 * ④ `entry_revisions.snapshot` —— 历史版本里的引用（回滚会用到，见文件头说明）。
 *
 * 只扫这四处是有意的取舍：SVG 内联、CSS `background-image`、`<video poster>`
 * 都不在这个系统里出现，为它们写扫描器是纯粹的猜测成本。
 */
export async function findMediaReferences(pathOrUrl: string): Promise<MediaReference[]> {
  const targets = new Set(pathnamesOf(pathOrUrl));
  if (targets.size === 0) return [];

  const db = await getAdminDb();

  // 粗筛：任一条 pathname 出现在 cover 或 body_md 里就当候选。
  // `coalesce(...,'')` 是必要的：`data->>'cover'` 在键不存在时返回 NULL，
  // 而 `NULL ILIKE '...'` 是 NULL，放进 `OR` 里不会让整行变真但会让语义更难读。
  const patterns = [...targets].map((target) => `%${escapeLike(target)}%`);
  const filters = patterns.flatMap((pattern) => [
    sql`coalesce(${entries.data}->>'cover', '') ilike ${pattern}`,
    ilike(entries.body_md, pattern),
  ]);

  const candidates = await db
    .select({
      kind: entries.kind,
      slug: entries.slug,
      title: entries.title,
      data: entries.data,
      body_md: entries.body_md,
    })
    .from(entries)
    .where(or(...filters));

  const hits: MediaReference[] = [];

  for (const row of candidates) {
    const cover = row.data?.cover;
    if (typeof cover === "string" && pathnamesOf(cover).some((value) => targets.has(value))) {
      hits.push({
        kind: row.kind as EntryKind,
        slug: row.slug,
        title: row.title,
        field: "data.cover",
      });
    }

    const bodyHits = extractImageSources(row.body_md).filter((source) =>
      pathnamesOf(source).some((value) => targets.has(value)),
    );
    if (bodyHits.length > 0) {
      hits.push({
        kind: row.kind as EntryKind,
        slug: row.slug,
        title: row.title,
        field: "body_md",
      });
    }
  }

  /*
   * 第四条路径：历史版本快照。
   *
   * 用 `snapshot::text ILIKE` 而不是拆 JSON 字段：快照的 schema 随业务字段演化，
   * 拆字段意味着每次加字段都要同步改这里；而「图片地址是一段子串」这个事实
   * 不随 schema 变化。粗筛可能多捞（`change_note` 里提到同一路径），
   * 但方向安全 —— 多拦一次删除，而不是漏拦导致破图。
   *
   * `::text` 强转是必须的，不是保险写法：`snapshot` 是 `jsonb` 列
   * （`db/schema.ts:205`），Postgres 里**没有** `jsonb ~~* text` 这个操作符，
   * 直接 `ilike(entryRevisions.snapshot, ...)` 会报
   * `operator does not exist: jsonb ~~* unknown`（PGlite 与真 Postgres 行为一致）。
   * 转成 text 之后比对的是序列化后的 JSON 字面量，图片地址原样在内。
   *
   * 只取 `entry_id` + `version`，再去 `entries` 表拿 kind/slug/title，
   * 避免把 entries 整行 join 回来（快照可能很大，且我们只需要定位信息）。
   */
  const snapshotFilters = patterns.map(
    (pattern) => sql`${entryRevisions.snapshot}::text ilike ${pattern}`,
  );

  const snapshotHits = await db
    .select({
      kind: entries.kind,
      slug: entries.slug,
      title: entries.title,
      version: entryRevisions.version,
    })
    .from(entryRevisions)
    .innerJoin(entries, eq(entries.id, entryRevisions.entry_id))
    .where(or(...snapshotFilters));

  for (const row of snapshotHits) {
    hits.push({
      kind: row.kind as EntryKind,
      slug: row.slug,
      title: row.title,
      field: `entry_revisions.snapshot(v${row.version})`,
    });
  }

  // 排序而不是依赖数据库返回顺序：`ILIKE` 粗筛走顺序扫描，行序不稳定，
  // 而调用方（删除前提示）要把结果直接展示给人，两次运行顺序不同会让人以为数据变了。
  hits.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.slug.localeCompare(b.slug);
  });

  return hits;
}
