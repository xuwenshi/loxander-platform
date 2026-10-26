#!/usr/bin/env node
/**
 * 上线前预检（preflight）。
 *
 * ── 这个脚本为什么存在 ───────────────────────────────────────────────
 * P0–P7 每一阶段都在加闸门，到 P7 收口时闸门已经散布在 6 个 npm script 里：
 * `typecheck` / `db:test` / `web:test` / `md:test` / `check:css` / `test:browser`，
 * 外加环境变量、迁移状态、产物完整性这些**没有任何闸门看着**的东西。
 *
 * 结果就是：真要上线时，人得凭记忆挨个跑一遍，漏跑一个就相当于那一项没验收。
 * P7 期就出过 —— 代码全绿但生产构建的 CSS 里一条 Tailwind 工具类都没有
 * （见 `scripts/check-css-completeness.mjs` 文件头），因为没人把「构建产物」当闸门。
 *
 * 这个脚本的唯一目标：**一条命令回答「现在能不能上」**。
 *
 * ── 设计原则 ─────────────────────────────────────────────────────────
 * 1. **只读**。除浏览器验收要起服务外，不写任何文件、不改数据库、不 push。
 *    之所以敢在上线前跑，就是因为它不会制造需要收拾的现场。
 * 2. **失败不早退**。跑完全部检查再汇总 —— 一次看到所有问题，而不是修一个跑一次。
 *    代价是单次更慢，但上线前的时间花在这里比花在「修一个跑一次」上划算。
 * 3. **区分阻断与提醒**（`blocking` vs `advisory`）。凭据类缺失在本地是常态
 *    （`.env` 里本来就没有 BLOB token），不该让本地跑一次就红一片；
 *    但它必须是「提醒」，否则上线时也忘了配 —— 那是真事故。
 * 4. **不重复实现闸门逻辑**。全部调用既有 npm script，不把 tsc/test 的断言抄一遍。
 *    抄一遍就意味着两套判据，迟早漂移。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   node scripts/preflight.mjs              # 全量（含浏览器验收，需先起服务）
 *   node scripts/preflight.mjs --fast       # 跳过浏览器验收与构建（改完代码后的快速自检）
 *   node scripts/preflight.mjs --json       # 机器可读汇总
 *
 * 退出码：0 = 全部阻断项通过；1 = 有阻断项失败；2 = 脚本自身出错。
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const WEB_APP = path.join(REPO_ROOT, "apps", "web");

const ARGS = new Set(process.argv.slice(2));
const FAST = ARGS.has("--fast");
const AS_JSON = ARGS.has("--json");

/* -------------------------------------------------------------------------- */
/* 结果收集                                                                    */
/* -------------------------------------------------------------------------- */

/** @type {{id:string,name:string,level:"blocking"|"advisory",ok:boolean,detail:string,ms:number}[]} */
const results = [];

function record(id, name, level, ok, detail, ms = 0) {
  results.push({ id, name, level, ok, detail, ms });
  if (!AS_JSON) {
    const icon = ok ? "✅" : level === "blocking" ? "❌" : "⚠️ ";
    const suffix = detail ? `  ${detail}` : "";
    console.log(`  ${icon} ${name}${suffix}`);
  }
  return ok;
}

function section(title) {
  if (!AS_JSON) console.log(`\n=== ${title} ===`);
}

/**
 * 起一个子进程并把 stdout/stderr 收回来。
 *
 * ⚠️ 这里为什么不用默认的 `encoding: "utf8"`（= 管道 stdio）：
 * 本机开发沙箱禁止**管道**形式的子进程 stdio，任何 `spawnSync(cmd, ..., {encoding})`
 * 都直接返回 `error: EPERM`、`status: null`、输出空串。
 * 最危险的是它**不抛异常** —— 调用方只判 `status === 0`，于是「根本没跑起来」
 * 被当成「跑了、通过了」。这个脚本第一版就这么错过：git 和全部 npm 命令
 * 静默失败，报告却写着「工作区干净」「0 秒」。
 *
 * 出路：把 stdout/stderr 指向**文件描述符**（不是管道），子进程就能起，
 * 输出也拿得到。stdin 用 "ignore"（管道 stdin 同样会被拦）。
 *
 * 仍然保留 `error` 字段并**强制让调用方看到它**（见 `runScript` 里的判断），
 * 因为这条通道换台机器可能又不成立，不能假设它总是成功。
 *
 * @returns {{ok:boolean, status:number|null, signal:string|null, error:string|null, out:string, ms:number}}
 */
function runProcess(command, args, options = {}) {
  const { cwd = REPO_ROOT, env, timeoutMs = 900_000 } = options;
  const started = Date.now();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  const logFile = path.join(tmpDir, "out.log");
  const fd = openSync(logFile, "w");
  let res;
  try {
    res = spawnSync(command, args, {
      cwd,
      stdio: ["ignore", fd, fd],
      timeout: timeoutMs,
      shell: true,
      env: env ?? process.env,
    });
  } finally {
    closeSync(fd);
  }
  let out = "";
  try {
    out = readFileSync(logFile, "utf8");
  } catch {
    out = "";
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判定 */
  }

  const error = res.error ? `${res.error.code ?? ""} ${res.error.message}`.trim() : null;
  return {
    // 关键：有 error 就是失败，不能因为 status 恰好是 0 就算通过
    ok: !error && res.status === 0,
    status: res.status,
    signal: res.signal ?? null,
    error,
    out,
    ms: Date.now() - started,
  };
}

/**
 * 跑一条 npm script。
 *
 * `shell: true` 是**必须**的：Windows 上 `npm` 是 `npm.cmd`，
 * 不走 shell 时连解析都失败。
 */
function runScript(script, timeoutMs = 900_000) {
  const r = runProcess("npm", ["run", script, "--silent"], {
    timeoutMs,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
  });
  return r;
}

/**
 * 从脚本输出里挑一行能说明问题的（失败时给 detail 用）。
 *
 * 注意顺序：先认 `spawn` 类错误。它们意味着**命令压根没跑**，
 * 此时输出里的任何「看起来像通过」的内容都不可信，必须优先暴露。
 */
function pickReason(r) {
  if (r.error) return `子进程启动失败：${r.error}`;
  const lines = String(r.out ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const patterns = [
    /^error TS\d+:/,
    /^not ok \d+/,
    /^# fail \d+/,
    /^ℹ fail [1-9]/,
    /FAIL/,
    /Error:/,
    /失败/,
    /expected /,
    /Missing/,
    /ENOENT/,
    /EPERM/,
  ];
  for (const p of patterns) {
    const hit = lines.find((l) => p.test(l));
    if (hit) return hit.slice(0, 200);
  }
  return lines.at(-1)?.slice(0, 200) ?? "";
}

/* -------------------------------------------------------------------------- */
/* 1. 环境与配置                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 读 `.env`（只是解析，不注入 process.env）。
 *
 * 为什么不注入：注入会污染后续 `runScript` 的环境，让「检查 .env」变成
 * 「用 .env 跑检查」—— 那测的就不是仓库当前状态了。
 * 现实值：脚本只判断「有没有配」，不看具体值，所以纯解析够用。
 */
function parseDotEnv(file) {
  if (!existsSync(file)) return null;
  const map = new Map();
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉成对引号（.env 常见写法），空值保留为空串以便区分「配了但空」
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

const dotEnv = parseDotEnv(path.join(REPO_ROOT, ".env"));
const env = (key) => process.env[key] ?? dotEnv?.get(key) ?? "";
const has = (key) => env(key).trim().length > 0;

function checkEnvironment() {
  section("1. 环境与配置");

  record(
    "env-file",
    ".env 存在（而非只有 .env.example）",
    "advisory",
    dotEnv !== null,
    dotEnv ? `${dotEnv.size} 个键` : "缺失；本地跑需要它，CI/Vercel 用平台环境变量",
  );

  const nodeVersion = process.versions.node;
  const major = Number(nodeVersion.split(".")[0]);
  record("node-version", "Node 版本 >= 20", "blocking", major >= 20, `当前 v${nodeVersion}`);

  const source = env("CONTENT_SOURCE");
  const sourceOk = source === "markdown" || source === "db";
  record(
    "content-source",
    "CONTENT_SOURCE 取值合法",
    "blocking",
    sourceOk,
    sourceOk ? source : `非法值 ${JSON.stringify(source)} —— 会直接抛错，不会静默回退`,
  );

  // 站点地址：代码读 NEXT_PUBLIC_SITE_URL，旧名 SITE_URL 无人读。
  // 这条专门抓「只配了旧名 → 站点静默用内置默认域名」。
  const siteUrl = env("NEXT_PUBLIC_SITE_URL");
  const legacySiteUrl = env("SITE_URL");
  const siteOk = siteUrl.trim().length > 0;
  record(
    "site-url",
    "NEXT_PUBLIC_SITE_URL 已配置（sitemap/RSS/canonical 的绝对地址来源）",
    "blocking",
    siteOk,
    siteOk
      ? siteUrl
      : legacySiteUrl
        ? `只配了旧名 SITE_URL=${legacySiteUrl}，但代码不读它 —— 站点会静默退回内置默认域名`
        : "缺失；会退回内置默认域名，sitemap/RSS 里的链接可能指错站",
  );

  // 数据库：只有 CONTENT_SOURCE=db 时才真的需要。
  const needDb = source === "db";
  const dbUrl = env("DATABASE_URL");
  record(
    "database-url",
    "DATABASE_URL 已配置",
    needDb ? "blocking" : "advisory",
    dbUrl.trim().length > 0,
    dbUrl.trim().length > 0
      ? dbUrl.includes("sslmode=require")
        ? "已配置（含 sslmode=require）"
        : "已配置但没带 sslmode=require —— Neon 会拒绝明文连接"
      : needDb
        ? "CONTENT_SOURCE=db 时必填"
        : "当前 CONTENT_SOURCE=markdown，暂不需要",
  );

  // 认证三件套。生产必填（AUTH_SECRET 缺失 Auth.js 直接抛 MissingSecretError）。
  // 本地缺了只是进不去后台，所以定 advisory；但一旦 CONTENT_SOURCE=db 说明
  // 是「像生产一样跑」，此时缺失就成了部署事故的前兆，仍标 advisory 但文案说清。
  const secretOk = has("AUTH_SECRET");
  record("auth-secret", "AUTH_SECRET 已配置（生产必填）", "advisory", secretOk,
    secretOk ? "已配置" : "缺失 —— 生产环境 Auth.js 会抛 MissingSecretError；本地每次重启都会掉登录");

  const ghId = has("AUTH_GITHUB_ID");
  const ghSecret = has("AUTH_GITHUB_SECRET");
  record("auth-github", "GitHub OAuth 凭据成对配置", "advisory", ghId && ghSecret,
    ghId && ghSecret ? "AUTH_GITHUB_ID + SECRET 均已配置"
      : !ghId && !ghSecret ? "两者都缺 —— 后台无法登录"
        : `只配了${ghId ? " ID" : " SECRET"}，缺少另一半`);

  const adminLogin = env("ADMIN_GITHUB_LOGIN").trim();
  record("admin-whitelist", "ADMIN_GITHUB_LOGIN 白名单非空", "advisory", adminLogin.length > 0,
    adminLogin.length > 0
      ? `${adminLogin.split(/[,\s]+/).filter(Boolean).length} 个账号`
      : "留空 = fail-closed（谁都进不去后台），不是「谁都能进」");

  const blobOk = has("BLOB_READ_WRITE_TOKEN");
  record("blob-token", "BLOB_READ_WRITE_TOKEN 已配置（媒体上传）", "advisory", blobOk,
    blobOk ? "已配置；上传进 Vercel Blob" : "缺失；降级写 apps/web/public/media/（Vercel 上只读，生产上传会失败）");
}

/* -------------------------------------------------------------------------- */
/* 2. 迁移状态（只读，与磁盘迁移文件对账）                                      */
/* -------------------------------------------------------------------------- */

function checkMigrations() {
  section("2. 数据库迁移");

  const dir = path.join(REPO_ROOT, "db", "migrations");
  if (!existsSync(dir)) {
    record("migrations-dir", "迁移目录存在", "blocking", false, dir);
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  record("migrations-files", "磁盘迁移文件可读", "blocking", files.length > 0, `${files.length} 份：${files.join(" / ")}`);

  // 每份迁移都必须有对应的 snapshot，否则 drizzle-kit 下次生成会基于旧快照，
  // 生成出的 SQL 会把已加的列再 ADD 一次 → 生产迁移直接失败。
  const metaDir = path.join(dir, "meta");
  const journalFile = path.join(metaDir, "_journal.json");
  if (!existsSync(journalFile)) {
    record("migrations-journal", "_journal.json 存在", "blocking", false, "缺失；drizzle-kit 无法算下一次迁移");
    return;
  }
  let journal;
  try {
    journal = JSON.parse(readFileSync(journalFile, "utf8"));
  } catch (e) {
    record("migrations-journal", "_journal.json 可解析", "blocking", false, String(e).slice(0, 160));
    return;
  }
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const journalTags = new Set(entries.map((e) => String(e.tag)));
  const fileTags = files.map((f) => f.replace(/\.sql$/, ""));
  const missingInJournal = fileTags.filter((t) => !journalTags.has(t));
  record(
    "migrations-journal-sync",
    "磁盘迁移与 _journal.json 完全对应",
    "blocking",
    missingInJournal.length === 0,
    missingInJournal.length === 0 ? `${entries.length} 条记录` : `journal 缺：${missingInJournal.join(", ")}`,
  );

  // snapshot 文件名用的是**序号**不是 tag：`0000_snapshot.json` 而不是
  // `0000_init_snapshot.json`。第一版按 tag 拼，结果三条全报「缺失」——
  // 假失败比漏检更费时间，因为它会让人去翻一个根本不存在的约定。
  // drizzle-kit 的约定就是 `<idx>_snapshot.json`，以 journal 里的 idx 补零到 4 位。
  const snapshots = entries.map((e) => `meta/${String(e.idx).padStart(4, "0")}_snapshot.json`);
  const missingSnapshots = snapshots.filter((s) => !existsSync(path.join(dir, s)));
  record(
    "migrations-snapshots",
    "每份迁移都有 snapshot（drizzle-kit 下次生成的基础）",
    "blocking",
    missingSnapshots.length === 0,
    missingSnapshots.length === 0 ? `${snapshots.length} 份齐全` : `缺：${missingSnapshots.join(", ")}`,
  );

  // 生产库是否有未应用的迁移 —— 这是**唯一**一条会连真库的检查，用 --status（只读）。
  if (!has("DATABASE_URL")) {
    record("migrations-remote", "生产库迁移已全部应用", "advisory", false,
      "没有 DATABASE_URL，跳过（无法确认线上库状态）");
    return;
  }
  const r = runProcess("node", ["db/migrate.ts", "--status"], {
    timeoutMs: 120_000,
    env: { ...process.env, DATABASE_URL: env("DATABASE_URL") },
  });
  // 真实输出形如「磁盘 3 份 / 库里已应用 3 份」。按数字比对而不是按文案匹配，
  // 这样以后措辞改了也不会误判。
  const applied = /库里已应用\s*(\d+)\s*份/.exec(r.out);
  const onDisk = /磁盘\s*(\d+)\s*份/.exec(r.out);
  const inSync = r.ok && applied && onDisk && applied[1] === onDisk[1];
  record(
    "migrations-remote",
    "生产库迁移已全部应用",
    "blocking",
    Boolean(inSync),
    inSync
      ? `磁盘 ${onDisk[1]} 份 / 已应用 ${applied[1]} 份`
      : r.error
        ? `子进程启动失败：${r.error}`
        : pickReason(r) || "存在未应用迁移，先跑 npm run db:migrate",
  );
}

/* -------------------------------------------------------------------------- */
/* 3. 构建产物                                                                 */
/* -------------------------------------------------------------------------- */

function checkBuildArtifacts() {
  section("3. 构建产物");

  const nextDir = path.join(WEB_APP, ".next");
  if (!existsSync(nextDir)) {
    record("next-build", ".next 构建产物存在", FAST ? "advisory" : "blocking", false,
      "缺失；先跑 npm run build:web:local（或 Vercel 上由平台构建）");
    return;
  }
  const buildIdFile = path.join(nextDir, "BUILD_ID");
  record("next-build", "BUILD_ID 存在（构建完整）", "blocking", existsSync(buildIdFile),
    existsSync(buildIdFile) ? readFileSync(buildIdFile, "utf8").trim() : "缺 BUILD_ID，构建可能中断");

  // CSS 完整性：这是 P7 抓到的那个「全站无样式但所有闸门全绿」缺陷。
  const r = runScript("check:css", 120_000);
  record("css-completeness", "构建产物 CSS 含全部 Tailwind 工具类", "blocking", r.ok,
    r.ok ? "齐全" : pickReason(r.out), r.ms);
}

/* -------------------------------------------------------------------------- */
/* 4. 代码闸门（typecheck / 单测 / 数据等价）                                    */
/* -------------------------------------------------------------------------- */

function checkCodeGates() {
  section("4. 代码闸门");

  const gates = [
    ["typecheck:web", "TypeScript（apps/web）"],
    ["typecheck:desktop", "TypeScript（apps/desktop）"],
    ["db:test", "数据库与映射单测"],
    ["web:test", "Web 端单测（接线 / 内容源 / 后台 / a11y / 快照）"],
    ["md:test", "Markdown 渲染单测"],
  ];

  for (const [script, name] of gates) {
    const r = runScript(script);
    record(script, name, "blocking", r.ok, r.ok ? `${Math.round(r.ms / 1000)}s` : pickReason(r.out), r.ms);
  }

  // 双路数据比对：markdown 与 db 两条实现必须给出一模一样的公开类型。
  // 没有 DATABASE_URL 时它跑不了（要连真库），本地降级为提醒。
  if (has("DATABASE_URL") || FAST) {
    const r = runScript("db:compare", 300_000);
    record("db:compare", "Markdown 与 DB 双路数据等价", "blocking", r.ok,
      r.ok ? "0 差异" : pickReason(r.out), r.ms);
  } else {
    record("db:compare", "Markdown 与 DB 双路数据等价", "advisory", false, "没有 DATABASE_URL，跳过");
  }
}

/* -------------------------------------------------------------------------- */
/* 5. 可提交流程卫生                                                           */
/* -------------------------------------------------------------------------- */

function checkRepoHygiene() {
  section("5. 仓库卫生");

  const git = (args) => {
    const r = runProcess("git", args, { timeoutMs: 60_000 });
    return { ok: r.ok, out: r.out.trim(), error: r.error };
  };

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchDetail = branch.ok
    ? branch.out
    : (branch.error ?? (branch.out.slice(0, 160) || "不是 git 仓库"));
  record("git-branch", "当前分支可读", "advisory", branch.ok, branchDetail);

  const status = git(["status", "--porcelain"]);
  const changed = status.ok ? status.out.split(/\r?\n/).filter(Boolean) : [];
  const tmpFiles = changed.filter((l) => /\.tmp-|\.mutbak|\.p2chapter/.test(l));
  record(
    "git-no-tmp",
    "工作区没有临时探针文件（.tmp-* / .mutbak*）",
    "blocking",
    tmpFiles.length === 0,
    tmpFiles.length === 0 ? "干净" : `${tmpFiles.length} 个待清理：${tmpFiles.slice(0, 5).map((l) => l.slice(3)).join(", ")}`,
  );

  // 敏感文件绝不能进 git。这条必须有牙：它查的是「是否已被跟踪」，
  // 不是「是否在工作区」—— 后者本来就要有 .env 才能跑。
  const tracked = git(["ls-files", ".env", "apps/web/.env.local"]);
  const trackedList = tracked.ok ? tracked.out.split(/\r?\n/).filter(Boolean) : [];
  record("git-no-secrets", ".env 未被 git 跟踪", "blocking", trackedList.length === 0,
    trackedList.length === 0 ? "未被跟踪" : `已被跟踪：${trackedList.join(", ")}`);

  const uncommitted = changed.length;
  record("git-clean", "工作区干净（可发布态）", "advisory", uncommitted === 0,
    uncommitted === 0 ? "无未提交改动" : `${uncommitted} 项未提交改动`);
}

/* -------------------------------------------------------------------------- */
/* 6. 运行时验收（需要已起服务）                                                */
/* -------------------------------------------------------------------------- */

async function checkRuntime() {
  section("6. 运行时验收");

  if (FAST) {
    record("runtime-skipped", "运行时验收（--fast 跳过）", "advisory", false, "已跳过健康检查与浏览器验收");
    return;
  }

  const base = process.env.PREFLIGHT_BASE_URL ?? "http://127.0.0.1:3310";

  // 健康检查。冷启动时 Neon 可能要几秒，所以给 30s 并重试。
  let healthOk = false;
  let healthDetail = "";
  for (let i = 0; i < 6 && !healthOk; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(30_000) });
      const body = await res.json();
      healthOk = res.ok && body?.ok === true;
      healthDetail = `status=${res.status} database=${body?.database ?? "?"} version=${String(body?.version ?? "?").slice(0, 12)}`;
    } catch (e) {
      healthDetail = `${e.cause?.code ?? e.name}（第 ${i + 1} 次）`;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  record("health", "GET /api/health 返回 ok:true 且 database:ok", "blocking", healthOk, healthDetail);

  if (!healthOk) {
    record("browser-acceptance", "浏览器验收（49 条）", "advisory", false, "服务未就绪，跳过");
    return;
  }

  // 浏览器验收需要外部已开 CDP 端口的浏览器（沙箱禁 fork，见脚本文件头）。
  const cdp = process.env.PREFLIGHT_CDP_URL ?? "http://127.0.0.1:9222";
  let cdpOk = false;
  try {
    const res = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(5000) });
    cdpOk = res.ok;
  } catch {
    cdpOk = false;
  }
  if (!cdpOk) {
    record("browser-acceptance", "浏览器验收（49 条）", "advisory", false,
      `CDP 端口 ${cdp} 无响应；先外部起浏览器 --remote-debugging-port=9222`);
    return;
  }

  const r = runScript("test:browser", 900_000);
  const passed = /通过 (\d+) \/ 失败 0/.exec(r.out);
  record("browser-acceptance", "浏览器验收（49 条）", "blocking", r.ok,
    r.ok ? (passed ? `通过 ${passed[1]} / 失败 0` : "全绿") : pickReason(r.out), r.ms);
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const started = Date.now();
  if (!AS_JSON) {
    console.log("上线前预检（preflight）");
    console.log(`仓库：${REPO_ROOT}`);
    console.log(`模式：${FAST ? "快速（跳过构建产物外的运行时验收）" : "全量"}`);
  }

  try {
    checkEnvironment();
    checkMigrations();
    checkBuildArtifacts();
    checkCodeGates();
    checkRepoHygiene();
    await checkRuntime();
  } catch (e) {
    console.error("\n[preflight] 脚本自身出错：", e);
    process.exit(2);
  }

  const blocking = results.filter((r) => r.level === "blocking");
  const advisory = results.filter((r) => r.level === "advisory");
  const failedBlocking = blocking.filter((r) => !r.ok);
  const failedAdvisory = advisory.filter((r) => !r.ok);

  if (AS_JSON) {
    console.log(JSON.stringify({
      ok: failedBlocking.length === 0,
      totalMs: Date.now() - started,
      summary: {
        blocking: { total: blocking.length, passed: blocking.length - failedBlocking.length, failed: failedBlocking.length },
        advisory: { total: advisory.length, passed: advisory.length - failedAdvisory.length, failed: failedAdvisory.length },
      },
      results,
    }, null, 2));
  } else {
    console.log("\n" + "=".repeat(72));
    console.log(
      `阻断项：${blocking.length - failedBlocking.length} / ${blocking.length} 通过` +
      `　提醒项：${advisory.length - failedAdvisory.length} / ${advisory.length} 通过` +
      `　耗时 ${Math.round((Date.now() - started) / 1000)}s`,
    );
    if (failedBlocking.length > 0) {
      console.log("\n❌ 阻断项未通过（必须修完才能上线）：");
      for (const r of failedBlocking) console.log(`  · ${r.name} —— ${r.detail}`);
    }
    if (failedAdvisory.length > 0) {
      console.log("\n⚠️  提醒项（不阻断本地，但上线前逐条确认）：");
      for (const r of failedAdvisory) console.log(`  · ${r.name} —— ${r.detail}`);
    }
    console.log(
      failedBlocking.length === 0
        ? "\n✅ 预检通过（阻断项全绿）。"
        : `\n❌ 预检失败：${failedBlocking.length} 个阻断项。`,
    );
  }

  process.exit(failedBlocking.length === 0 ? 0 : 1);
}

await main();
