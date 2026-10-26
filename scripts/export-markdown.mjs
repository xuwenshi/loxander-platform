#!/usr/bin/env node
/**
 * 数据库 → Markdown 导出（P8-3「Markdown 仅保留导入和导出用途」的**导出**半边）。
 *
 * 用法：
 *   node scripts/export-markdown.mjs                     # 导出到 content-export/<时间戳>/
 *   node scripts/export-markdown.mjs --out some/dir      # 指定输出目录
 *   node scripts/export-markdown.mjs --dry-run           # 只报告将写哪些文件，不落盘
 *   node scripts/export-markdown.mjs --verify <dir>      # 只读比对：<dir> 与当前库是否一致
 *
 * ## 为什么需要它
 *
 * 导入（`db/import.ts`）只解决了「旧 markdown → 新库」。P8 要求 markdown 保留**导出**用途，
 * 否则一旦库出事，内容只剩 JSON 备份（`scripts/db-backup.mjs` 的 dump 是带 uuid / 时间戳 /
 * publish_status 的库行形状），人读不了、别的工具也接不上。导出产物必须是**能被
 * `db/import.ts` 原样吃回去**的 markdown —— 这是「往返等价」的定义，`--verify` 就是验这个。
 *
 * ## 与导入的对称性（每一条都是契约）
 *
 * 下表左列是导出要还原的字段，右列是 `db/mapping.ts:mapEntry` 当初怎么塞进库的：
 *
 * | markdown frontmatter | 库里的位置 | 导出时怎么取回 |
 * |---|---|---|
 * | `title` | `entries.title` | 直接读 |
 * | `description`（blog）/ `summary`（diary）/ `description`（projects）/ 无（goals） | `entries.summary` | 按 kind 决定键名 |
 * | `name`（projects） | `entries.title` | projects 的 title 列存的是 `name` |
 * | `date` | `entries.display_date` | 直接读（projects/goals 为 null，不输出） |
 * | `category` / `cover` / `coverWidth` / `coverHeight` | `entries.data.category` 等 | 读 `data` |
 * | `mood` | `entries.data.mood` | 读 `data` |
 * | `techStack`/`status`/`period`/`role`/`github`/`demo`/`article`/`featured`/`order` | `entries.data.*` + `featured`/`sort_order` 列 | 读 data + 列 |
 * | `horizon`/`status`/`progress`/`period`/`order`/`milestones` | `entries.data.*` + `sort_order` 列 | 读 data + 列 |
 * | `tags` | `tags` + `entry_tags`（`tag_order` 保序） | join 回来，按 tag_order 排 |
 * | `draft` | `entries.publish_status` | `draft === true` 仅当 status 为 `draft` |
 * | 正文 | `entries.body_md` | 直接读 |
 *
 * **不导出的东西**（有意的，写在这里以免后人以为是漏了）：
 * - `entries.body_html` —— 派生缓存，`db/import.ts` 会按 `renderOptionsForKind(kind)` 重算；
 *   导出它只会让 markdown 里多一份和正文可能不一致的 HTML。
 * - `entries.version` / `created_at` / `updated_at` / `created_by` / `updated_by` ——
 *   这些是「这一行在库里的生命史」，不是内容。导回时会重新生成。
 * - `entry_revisions` / `audit_logs` —— 同上，属于平台运行记录，不属于内容。
 * - `publish_status` 为 `scheduled` / `archived` 的条目：**照常导出**，但 `scheduled` 会因
 *   schema 里没有对应字段而退化成 `draft: false`（诚实说明：content-core 的四个 schema
 *   只有 blog/diary 有 `draft` 布尔，表达不了四态；这是已知的表达力上限，不是本脚本的疏忽）。
 *
 * ## 输出格式
 *
 * 与仓库里现有的 `apps/web/content/*.md` 逐字节对齐：
 * - `---\n` + frontmatter + `---\n\n` + 正文；
 * - 字符串用双引号 + JSON 转义（与 gray-matter 写回的风格一致）；
 * - `date` 裸写 `YYYY-MM-DD`（不加引号，因为 `zDate` 的 preprocess 认得裸日期）；
 * - 数组用 `["a", "b"]` 行内风格 —— **与现有内容文件一致**，不是块风格。
 *
 * 本脚本**只读数据库、只写文件**，不调用 git、不碰远端。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");
const EXPORT_ROOT = join(REPO_ROOT, "content-export");

/** 四个内容分区。顺序即导出顺序，也即目录遍历顺序。 */
const KINDS = ["blog", "diary", "projects", "goals"];

/* -------------------------------------------------------------------------- */
/* 参数                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { out: null, dryRun: false, verify: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--out") opts.out = argv[++i] ?? null;
    else if (a === "--verify") opts.verify = argv[++i] ?? null;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

/* -------------------------------------------------------------------------- */
/* frontmatter 序列化                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 字符串 → YAML 双引号标量。
 *
 * 用 `JSON.stringify` 而不是手写转义：JSON 的字符串转义是 YAML 双引号风格的子集
 * （`\"` `\\` `\n` `\t` `\uXXXX` 含义一致），而 YAML 1.2 是 JSON 的超集，
 * 所以 gray-matter 的 YAML 解析器能原样读回。手写转义一定会漏掉某个控制字符。
 */
function q(value) {
  return JSON.stringify(String(value));
}

/**
 * 行内数组：`["a", "b"]`。
 *
 * 与现有 `apps/web/content/blog/*.md` 的写法一致（它们是 `tags: ["RAG", "LLM"]`）。
 * 空数组写成 `[]`（content-core 的 `zStringSet` 默认值就是空数组，写 `[]` 与省略等价，
 * 但显式写出来更利于人眼核对）。
 */
function inlineArray(values) {
  return `[${values.map(q).join(", ")}]`;
}

/**
 * 按 kind 生成 frontmatter 行数组。**键序与 `apps/web/content/` 里的实际文件一致**，
 * 这样导出产物与历史文件放在一起 diff 时噪声最小。
 */
function frontmatterLines(kind, row, tags) {
  const lines = [];
  const data = row.data ?? {};

  if (kind === "blog") {
    lines.push(`title: ${q(row.title)}`);
    lines.push(`description: ${q(row.summary)}`);
    if (row.display_date) lines.push(`date: ${row.display_date}`);
    lines.push(`category: ${q(data.category ?? "未分类")}`);
    lines.push(`tags: ${inlineArray(tags)}`);
    if (data.cover) lines.push(`cover: ${q(data.cover)}`);
    // coverWidth / coverHeight 是导入时从 SVG 里解析出来的，**不是 frontmatter 的原生字段**。
    // content-core 的 blogSchema 里没有这两个键，写回去会被 zod 的 default strip 掉（不进 data）。
    // 所以导出时故意不写 —— 写了只会让下一次导入多出一对无主字段。
    // （它们唯一的作用是让 <Image> 提前拿到尺寸避免 CLS，库里有就够了。）
    if (row.publish_status === "draft") lines.push("draft: true");
    return lines;
  }

  if (kind === "diary") {
    // 现有 diary 文件的键序是 date → title → summary → mood（见 week01.md）。
    if (row.display_date) lines.push(`date: ${row.display_date}`);
    lines.push(`title: ${q(row.title)}`);
    lines.push(`summary: ${q(row.summary)}`);
    if (data.mood) lines.push(`mood: ${q(data.mood)}`);
    if (tags.length > 0) lines.push(`tags: ${inlineArray(tags)}`);
    if (row.publish_status === "draft") lines.push("draft: true");
    return lines;
  }

  if (kind === "projects") {
    // projects 用 name 不是 title；title 列里存的就是 name 的值。
    lines.push(`name: ${q(row.title)}`);
    lines.push(`description: ${q(row.summary)}`);
    lines.push(`techStack: ${inlineArray(Array.isArray(data.techStack) ? data.techStack : [])}`);
    lines.push(`status: ${q(data.status ?? "active")}`);
    if (data.period) lines.push(`period: ${q(data.period)}`);
    if (data.role) lines.push(`role: ${q(data.role)}`);
    if (data.github) lines.push(`github: ${q(data.github)}`);
    if (data.demo) lines.push(`demo: ${q(data.demo)}`);
    if (data.article) lines.push(`article: ${q(data.article)}`);
    // featured / order 在库里有独立列，不在 data 里。**只在非默认值时写出**：
    // featured 默认 false、order 默认 999（`db/mapping.ts:DEFAULT_SORT_ORDER`），
    // 写出来是噪声，不写则导入时回到同样的默认值 —— 往返仍然等价。
    if (row.featured === true) lines.push("featured: true");
    if (typeof row.sort_order === "number" && row.sort_order !== 999) lines.push(`order: ${row.sort_order}`);
    return lines;
  }

  if (kind === "goals") {
    lines.push(`title: ${q(row.title)}`);
    lines.push(`horizon: ${q(data.horizon ?? "short")}`);
    lines.push(`status: ${q(data.status ?? "planned")}`);
    lines.push(`progress: ${typeof data.progress === "number" ? data.progress : 0}`);
    if (data.period) lines.push(`period: ${q(data.period)}`);
    if (typeof row.sort_order === "number" && row.sort_order !== 999) lines.push(`order: ${row.sort_order}`);
    const milestones = Array.isArray(data.milestones) ? data.milestones : [];
    if (milestones.length === 0) {
      // 空数组显式写出：`zMilestones` 有 default([]) 所以省略也等价，
      // 但目标类内容「有里程碑」是常态，写 `milestones: []` 让人一眼看出是真的没有。
      lines.push("milestones: []");
    } else {
      lines.push("milestones:");
      for (const m of milestones) {
        lines.push(`  - title: ${q(m?.title ?? "")}`);
        lines.push(`    done: ${m?.done === true ? "true" : "false"}`);
      }
    }
    return lines;
  }

  throw new Error(`未知内容分区：${kind}`);
}

/**
 * 组装完整 markdown 文本。
 *
 * 结尾统一一个换行：`apps/web/content/` 里所有文件都是这个结尾，
 * `matter()` 解析后 `content` 会带上 frontmatter 后的空行，而 `mapEntry` 会 `trim()`，
 * 所以这里怎么写都不影响往返等价；写成和现有文件一致是为了 diff 干净。
 */
function buildMarkdown(kind, row, tags) {
  const fm = frontmatterLines(kind, row, tags);
  const body = row.body_md ?? "";
  return `---\n${fm.join("\n")}\n---\n\n${body}\n`;
}

/* -------------------------------------------------------------------------- */
/* 读库                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 解析数据库连接串：环境变量优先，其次仓库根 `.env`。
 *
 * 单独抽出来是因为**日志里要打它的脱敏形态**，而日志只能拿到「实际用的那个串」——
 * 第一版在 `runExport` 里写 `maskUrl(process.env.DATABASE_URL)`，结果 `.env` 场景下
 * 恒打印「(无法解析的连接串)」，看着像故障其实一切正常。取值与打日志必须同源。
 */
function resolveDatabaseUrl() {
  const envPath = join(REPO_ROOT, ".env");
  let url = process.env.DATABASE_URL;
  if (!url && existsSync(envPath)) {
    const text = readFileSync(envPath, "utf8");
    const m = /^DATABASE_URL=(.*)$/m.exec(text);
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!url) throw new Error("[export] 缺 DATABASE_URL：请在 .env 里配置或用环境变量传入。");
  return url;
}

/**
 * 懒加载数据库连接（与 `scripts/db-backup.mjs` 同法：仓库根依赖 + 仓库根 .env）。
 *
 * 不 import `apps/web` 的任何模块：那些模块带 `server-only`，纯 node 下会直接抛错，
 * 而且会把 Shiki / unified 整个拖进来。这里只要两张表的关系，直接写 SQL 最省。
 */
async function connect() {
  const pgRoot = require.resolve("postgres", { paths: [REPO_ROOT] });
  const { default: postgres } = await import(`file://${pgRoot.replace(/\\/g, "/")}`);
  // `connect_timeout` 不能省：Neon 免费版冷启动实测可到 4320ms（本仓库 P5 期记录过），
  // 不设超时的时候 postgres-js 会一直等，而中间网络设备往往先超时断开，
  // 表现为 `read ECONNRESET` —— 看起来像库挂了，其实只是没人等够。
  return postgres(resolveDatabaseUrl(), { max: 1, connect_timeout: 20, onnotice: () => {} });
}

/**
 * 带重试地跑一个查询函数。
 *
 * 为什么需要：Neon 免费版在空闲后会 scale-to-zero，第一个连接要等它唤醒；
 * 唤醒期间偶尔会出现连接被重置（`read ECONNRESET` / `Connection terminated`）。
 * 这是**环境特性不是代码缺陷**，对它做重试是正确的处理方式；
 * 重试次数刻意只有 3 次、每次间隔 2s，避免把「库真的连不上」拖成两分钟的假死。
 */
async function withRetry(label, run) {
  const attempts = 3;
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const code = error?.code ?? "";
      const transient = /ECONNRESET|ETIMEDOUT|Connection terminated|ECONNREFUSED|timeout exceeded/i.test(
        `${code} ${error?.message ?? ""}`,
      );
      if (!transient || i === attempts) break;
      console.warn(`[export] ${label} 第 ${i} 次失败（${code || error?.message}），${2} 秒后重试…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

/**
 * 读出全部条目 + 标签。
 *
 * 标签用一次 join 全量取出再在内存分组，不做 N+1 —— 内容量到万级时才有必要改分页，
 * 当前 10 篇，一次查完最简单也最快。
 */
async function loadAll(sql) {
  // `display_date` 在 SQL 里就格式化成 'YYYY-MM-DD' 字符串。
  //
  // 为什么不在 JS 里格式化：postgres-js 会把 `date` 列解析成 JS `Date` 对象，
  // 而 `String(date)` 得到的是 `Mon Oct 12` 这种人类可读形式 —— 直接毁掉 frontmatter。
  // 用 `to_char` 让 Postgres 给出唯一正确的答案，绕开「Date 对象在哪个时区转字符串」
  // 这个每次都要重新推理一遍的坑（`date` 列本就没有时区概念，任何 JS 侧转换都在引入假设）。
  const rows = await sql`
    select id, kind, slug, title, summary, body_md, publish_status, featured, sort_order,
           to_char(display_date, 'YYYY-MM-DD') as display_date, data
    from entries
    order by kind, slug
  `;

  const tagRows = await sql`
    select et.entry_id, t.name, et.tag_order
    from entry_tags et
    join tags t on t.id = et.tag_id
    order by et.entry_id, et.tag_order
  `;

  const tagsByEntry = new Map();
  for (const t of tagRows) {
    const list = tagsByEntry.get(t.entry_id) ?? [];
    list.push(t.name);
    tagsByEntry.set(t.entry_id, list);
  }

  return rows.map((r) => ({
    ...r,
    // to_char 已经给了字符串或 null；这里保留 null 而不是空串，
    // 因为 `frontmatterLines` 用 `if (row.display_date)` 判断「要不要输出 date 键」。
    display_date: r.display_date ?? null,
    tags: tagsByEntry.get(r.id) ?? [],
  }));
}

/* -------------------------------------------------------------------------- */
/* 导出                                                                        */
/* -------------------------------------------------------------------------- */

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function runExport(opts) {
  const client = await connect();
  try {
    const rows = await withRetry("读取条目", () => loadAll(client));
    const outDir = opts.out ? resolvePath(REPO_ROOT, opts.out) : join(EXPORT_ROOT, timestamp());

    const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
    const files = [];
    for (const row of rows) {
      if (!KINDS.includes(row.kind)) {
        // 库里不该出现别的 kind（`entries_kind_check` 已经约束了），
        // 但导出是「最后一根救命稻草」，遇到脏数据要报告而不是静默丢。
        console.warn(`[export] 跳过未知 kind：${row.kind}/${row.slug}`);
        continue;
      }
      const markdown = buildMarkdown(row.kind, row, row.tags);
      const relative = `${row.kind}/${row.slug}.md`;
      files.push({ relative, markdown, kind: row.kind });
      counts[row.kind] += 1;
    }

    if (opts.dryRun) {
      console.log(`[export] --dry-run：将写出 ${files.length} 个文件到 ${outDir}`);
      for (const f of files) console.log(`  ${f.relative}  ${Buffer.byteLength(f.markdown, "utf8")} B`);
      return { ok: true, counts, total: files.length, outDir, written: 0 };
    }

    for (const kind of KINDS) mkdirSync(join(outDir, kind), { recursive: true });
    for (const f of files) writeFileSync(join(outDir, f.relative), f.markdown, "utf8");

    console.log(`[export] 来源：${maskUrl(resolveDatabaseUrl())}`);
    console.log(`[export] 输出：${outDir}`);
    console.log(`[export] 共 ${files.length} 个文件：` + KINDS.map((k) => `${k} ${counts[k]}`).join(" / "));
    return { ok: true, counts, total: files.length, outDir, written: files.length };
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** 只留 host 与 db 名，绝不打印连接串（方案 §13.4「错误日志不输出密钥」）。 */
function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(无法解析的连接串)";
  }
}

/* -------------------------------------------------------------------------- */
/* 校验（--verify）                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 逐文件比对 `dir` 与当前库。
 *
 * ## 为什么**不**做字节比对（第一版做了，是错的）
 *
 * 第一版把「导出产物与 `apps/web/content/` 逐字节相等」当验收口径，跑出来 10/10 全不等。
 * 逐个查清后发现**两类差异都不可能消除**，而且都不是缺陷：
 *
 * 1. **导入期就已经丢掉的字符**。`diary/week01.md` 的 `mood: "maybe so bad i am so tried "`
 *    尾部有一个空格；`packages/content-core/src/primitives.ts` 的 `zOptionalString` 会 `trim()`，
 *    库里存的是没有尾空格的值。导出不可能凭空造出那个空格 —— 这是 P2 导入契约的既定行为
 *    （当时刻意决定的：尾空白是脏数据），不是导出的 bug。
 * 2. **frontmatter 与正文之间的空行数量**。原文件有的是 `---\n<正文>`、有的是 `---\n\n<正文>`；
 *    `gray-matter` 把这个空行算进 content，`mapEntry` 又统一 `trim()`，所以空行个数在库里
 *    没有留下任何痕迹，导出只能挑一种写法。
 *
 * 所以字节比对测的是「原文件的历史书写习惯」，不是「往返是否等价」。真正的等价定义是：
 * **把导出的 markdown 重新走一遍导入路径（`db/mapping.ts:mapEntry`），得到的行与库里的行相等。**
 * 这才是有意义的那件事 —— 它证明「库出事时，这份导出能把库原样重建出来」。
 *
 * ## 实现要点
 *
 * 复用 `db/mapping.ts` 的 `mapEntry`，**不另写一套解析**。否则校验器会成为第二实现，
 * 「校验通过」就退化成「校验器和生成器互相认同」——P2 期已经在这类空转断言上踩过。
 *
 * 比对字段：`title` / `summary` / `body_md` / `publish_status` / `featured` / `sort_order` /
 * `display_date` / `data`（深比较）/ `tags`（含顺序）。
 * 不比对 `published_at`（projects/goals 是导入时刻的 `now()`，重放必然不同）、
 * `version` / `created_at` / `updated_at`（库行生命史，不属于内容）、`body_html`（派生）。
 */
function runVerify(dir) {
  const abs = resolvePath(REPO_ROOT, dir);
  if (!existsSync(abs)) throw new Error(`[verify] 目录不存在：${abs}`);
  return { abs };
}

/** 懒加载 `db/mapping.ts`（TS 源码，靠 node 的类型剥离直接跑）。 */
async function loadMapping() {
  // 必须先装 import hook 再 import 任何 TS 源码。
  //
  // `db/mapping.ts` import 了 `@loxander/content-core`，而那个包的 `main` 指向
  // `./src/index.ts`，其内部全是**无扩展名**的相对 import（`./kinds`、`./parse`…）。
  // node 的 TS 类型剥离（type stripping）只做语法层变换，不做模块解析，
  // 所以 `import './kinds'` 会去找 `kinds` 这个无扩展名文件并失败。
  // 仓库里所有离线测试（`p3-wiring.test.ts` / `p7-proxy-rules.test.ts` …）都靠
  // `registerHooks` 手工补 `.ts` 后缀，这里沿用同一套做法，避免出现「测试能跑、脚本不能跑」。
  const { registerHooks } = await import("node:module");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        // 只在「无扩展名的相对路径」上补后缀重试，其余错误原样抛出。
        if (!specifier.startsWith(".")) throw error;
        for (const suffix of [".ts", ".tsx", "/index.ts"]) {
          try {
            return nextResolve(specifier + suffix, context);
          } catch {
            /* 继续试下一个后缀 */
          }
        }
        throw error;
      }
    },
  });

  const mappingPath = join(REPO_ROOT, "db", "mapping.ts");
  const mod = await import(`file://${mappingPath.replace(/\\/g, "/")}`);
  return mod;
}

/** 深比较两个 JSON 值（键序无关）。 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  if (ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * 把一条导出文件重新走导入路径，得到 `mapEntry` 会写进库的行。
 *
 * `MapContext` 里 `publicDir` 指向 `apps/web/public`（读 SVG 封面尺寸要用），
 * `knownBlogSlugs` 传库里的 blog slug 全集（`projects.article` 的引用完整性检查要用）。
 * 两者都只影响 warning，不影响 blocking，但传对了才能保证 data 里的 coverWidth 等字段与库里一致。
 */
async function reimportOne(mapping, kind, slug, raw, ctx) {
  const result = mapping.mapEntry(kind, slug, raw, ctx);
  if (!result.ok) {
    return { ok: false, issues: result.issues };
  }
  return { ok: true, row: result.row, tags: result.tags };
}

async function compareWithDir(client, abs) {
  const mapping = await loadMapping();
  const rows = await withRetry("读取条目", () => loadAll(client));
  const problems = [];
  let same = 0;

  const blogSlugs = rows.filter((r) => r.kind === "blog").map((r) => r.slug);
  const ctx = {
    publicDir: join(REPO_ROOT, "apps", "web", "public"),
    knownBlogSlugs: blogSlugs,
  };

  const byRelative = new Map();
  for (const row of rows) {
    if (!KINDS.includes(row.kind)) continue;
    byRelative.set(`${row.kind}/${row.slug}.md`, row);
  }

  // 1. 库里的每一条，磁盘上必须有，且重新导入后与库行等价
  for (const [rel, dbRow] of byRelative) {
    const file = join(abs, rel);
    if (!existsSync(file)) {
      problems.push(`缺文件：${rel}`);
      continue;
    }
    const raw = readFileSync(file, "utf8");
    const back = await reimportOne(mapping, dbRow.kind, dbRow.slug, raw, ctx);
    if (!back.ok) {
      const msg = back.issues.map((i) => `${i.field ?? "-"}: ${i.message}`).join("; ");
      problems.push(`重新导入被拒：${rel} —— ${msg}`);
      continue;
    }

    const got = back.row;
    const diffs = [];
    if (got.title !== dbRow.title) diffs.push(`title:「${got.title}」≠「${dbRow.title}」`);
    if (got.summary !== dbRow.summary) diffs.push(`summary:「${got.summary}」≠「${dbRow.summary}」`);
    if (got.body_md !== dbRow.body_md) diffs.push(`body_md 长度 ${got.body_md.length} ≠ ${dbRow.body_md.length}`);
    if (got.publish_status !== dbRow.publish_status)
      diffs.push(`publish_status:${got.publish_status} ≠ ${dbRow.publish_status}`);
    if (got.featured !== dbRow.featured) diffs.push(`featured:${got.featured} ≠ ${dbRow.featured}`);
    if (got.sort_order !== dbRow.sort_order) diffs.push(`sort_order:${got.sort_order} ≠ ${dbRow.sort_order}`);
    if (got.display_date !== dbRow.display_date) diffs.push(`display_date:${got.display_date} ≠ ${dbRow.display_date}`);
    if (!deepEqual(got.data, dbRow.data)) {
      diffs.push(`data 不同：${JSON.stringify(got.data)} ≠ ${JSON.stringify(dbRow.data)}`);
    }
    if (!deepEqual(back.tags, dbRow.tags)) {
      diffs.push(`tags:[${back.tags.join(",")}] ≠ [${dbRow.tags.join(",")}]`);
    }

    if (diffs.length === 0) same += 1;
    else problems.push(`往返不等价：${rel} —— ${diffs.join("；")}`);
  }

  // 2. 磁盘上多出来的 .md（库里没有）也算差异 —— 通常意味着有人手工加了内容没入库
  for (const kind of KINDS) {
    const dirPath = join(abs, kind);
    if (!existsSync(dirPath)) continue;
    for (const name of readdirSync(dirPath)) {
      if (!name.endsWith(".md")) continue;
      const rel = `${kind}/${name}`;
      if (!byRelative.has(rel)) problems.push(`多文件（库中无此条目）：${rel}`);
    }
  }

  return { same, total: byRelative.size, problems };
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#![^\n]*\n/, ""));
    return 0;
  }

  if (opts.verify) {
    const { abs } = runVerify(opts.verify);
    const client = await connect();
    try {
      const { same, total, problems } = await compareWithDir(client, abs);
      console.log(`[verify] 比对目录：${abs}`);
      console.log(`[verify] 库中条目 ${total} 个，往返等价 ${same} 个，问题 ${problems.length} 处`);
      if (problems.length > 0) {
        for (const p of problems) console.log(`  ✗ ${p}`);
        console.log("[verify] 结果：不一致");
        return 1;
      }
      console.log("[verify] 结果：全部条目「导出 → 重新导入」后与库等价");
      return 0;
    } finally {
      await client.end({ timeout: 5 });
    }
  }

  const r = await runExport(opts);
  return r.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[export] 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
