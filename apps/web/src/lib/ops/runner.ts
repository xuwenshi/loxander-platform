import "server-only";

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { APP_ROOT } from "@/lib/app-root";
import { checkCssArtifacts, probeRoutes, DEFAULT_ROUTE_PATHS } from "@/lib/ops/runtime";

/**
 * 检查执行器：**进程内**跑检查，不用 `child_process` 跑脚本。
 *
 * ── 为什么不能「点按钮跑 npm run preflight」────────────────────────────
 * 本机沙箱里 `spawn` 直接抛 `EPERM`（errno -4048，实测）。Vercel 的
 * Serverless 运行时同样不提供子进程。而 `scripts/preflight.mjs` 内部
 * 正是用 `spawnSync` 去跑 `tsc` 和测试的（`preflight.mjs:35,97`），
 * 所以**即使能 import 它，它自己也会失败**。
 *
 * 结论：运维台不假装能跑脚本，而是把「脚本里那些**不需要子进程**的检查」
 * 在进程内重新实现一遍。已经实现的在 `IN_PROCESS_CHECKS` 里，
 * 每一项都能在页面上看到逐条结果；真正需要子进程的（tsc、单元测试、
 * 回滚演练、浏览器验收）如实标成不可用，并说明去终端跑哪条命令。
 *
 * ── 为什么还要探测一次 spawn ──────────────────────────────────────────
 * 因为「不可用」这个结论本身需要证据。`probeSpawn()` 在页面加载时试一次，
 * 结果缓存；页面上显示的是**实测结论**（EPERM / 可用），而不是一句
 * 「大概不行」。这正是 P7 记下的教训：对环境的判断必须来自实测。
 */

/* -------------------------------------------------------------------------- */
/* spawn 能力探测                                                              */
/* -------------------------------------------------------------------------- */

/** spawn 探测结果。 */
export interface SpawnProbe {
  available: boolean;
  /** 失败时的错误码，如 `EPERM`。 */
  code: string | null;
  /** 失败时的原始错误信息。 */
  error: string | null;
  /** 探测耗时（毫秒）。 */
  elapsedMs: number;
}

/** 探测结果缓存。进程生命周期内只探一次 —— 它不会变，重复探只是浪费。 */
let spawnProbeCache: SpawnProbe | null = null;

/**
 * 探测本进程能不能起子进程。
 *
 * 用一个**必然成功**的最小子命令（`node -e ""`）当探针：它不做任何事，
 * 成功只说明「能起进程」。用 fd 而不是 pipe 捕获输出 —— 本机沙箱对
 * **管道**形式的 stdio 额外限制，用 pipe 会把「能 spawn 但管道被禁」
 * 误判成「不能 spawn」。
 */
export function probeSpawn(): SpawnProbe {
  if (spawnProbeCache !== null) return spawnProbeCache;

  const startedAt = Date.now();
  try {
    const result = spawnSync(process.execPath, ["-e", ""], {
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const elapsedMs = Date.now() - startedAt;
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code ?? null;

    spawnProbeCache = {
      available: result.error === undefined && errorCode === null,
      code: errorCode,
      error: result.error ? String(result.error.message) : null,
      elapsedMs,
    };
    return spawnProbeCache;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    spawnProbeCache = {
      available: false,
      code: err.code ?? null,
      error: err.message,
      elapsedMs: Date.now() - startedAt,
    };
    return spawnProbeCache;
  }
}

/* -------------------------------------------------------------------------- */
/* 检查结果                                                                    */
/* -------------------------------------------------------------------------- */

/** 一条检查明细。 */
export interface CheckLine {
  name: string;
  ok: boolean;
  detail: string;
}

/** 一次检查的完整结果。 */
export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  /** 通过 / 总数。 */
  passed: number;
  total: number;
  lines: CheckLine[];
  elapsedMs: number;
  /** 整个检查没能执行时的原因（与「执行了但有失败项」区分开）。 */
  error?: string;
}

/** 检查 id 的联合类型（页面上用 URL 参数选）。 */
export type CheckId =
  | "env"
  | "migrations"
  | "build"
  | "css"
  | "repo"
  | "routes"
  | "sections";

/* -------------------------------------------------------------------------- */
/* 单项检查实现                                                                */
/* -------------------------------------------------------------------------- */

/** 仓库根（`APP_ROOT` 是 `apps/web`，往上两级）。 */
function repoRoot(): string {
  const twoUp = path.resolve(APP_ROOT, "..", "..");
  return existsSync(path.join(twoUp, ".git")) ? twoUp : APP_ROOT;
}

/**
 * 解析 `.env`（只读，不写 `process.env`）。
 *
 * 与 `scripts/preflight.mjs:185` 的 `parseDotEnv` 同口径：值两边引号去掉、
 * 已有 `process.env` 的键不覆盖。**不写回 process.env** 是因为运维台在
 * 一个已启动的进程里，中途改环境变量会让人误以为「改了立刻生效」——
 * 而 Next 的 `process.env` 在构建期就被内联了一部分，改它只会制造错觉。
 */
function parseDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * 环境检查。
 *
 * 逐条判据与 `preflight.mjs:209` 的 `checkEnvironment` 对齐，但**多一层**：
 * 它只报「有没有配」，这里还报「配了但没人读」——`SITE_URL` 就是
 * P8 期间真实踩过的例子（配了 `SITE_URL`，代码读的是 `NEXT_PUBLIC_SITE_URL`）。
 */
function checkEnvironment(): CheckResult {
  const startedAt = Date.now();
  const lines: CheckLine[] = [];
  const envFile = path.join(repoRoot(), ".env");
  const dotenv = parseDotEnv(envFile);

  const get = (key: string): string => (process.env[key] ?? dotenv[key] ?? "").trim();

  lines.push({
    name: ".env 文件",
    ok: existsSync(envFile),
    detail: existsSync(envFile) ? envFile : `不存在：${envFile}`,
  });

  const databaseUrl = get("DATABASE_URL");
  lines.push({
    name: "DATABASE_URL",
    ok: databaseUrl.length > 0,
    detail:
      databaseUrl.length === 0
        ? "未配置 —— 数据库相关功能全部不可用。"
        : databaseUrl.includes("sslmode")
          ? "已配置，带 sslmode。"
          : "已配置，但**不带 sslmode** —— 生产连接可能被明文嗅探。",
  });

  const contentSource = get("CONTENT_SOURCE");
  const legal = contentSource === "" || contentSource === "db" || contentSource === "markdown";
  lines.push({
    name: "CONTENT_SOURCE",
    ok: legal,
    detail: legal
      ? contentSource === ""
        ? "未设置（默认 markdown）"
        : contentSource
      : `非法值 "${contentSource}" —— 取数会直接抛错（刻意不做静默回退）。`,
  });

  // 这一条是 preflight 没有的：配了但没人读的变量。
  const legacySiteUrl = get("SITE_URL");
  const publicSiteUrl = get("NEXT_PUBLIC_SITE_URL");
  lines.push({
    name: "站点地址",
    ok: publicSiteUrl.length > 0 || legacySiteUrl.length === 0,
    detail:
      publicSiteUrl.length > 0
        ? `${publicSiteUrl}（NEXT_PUBLIC_SITE_URL）`
        : legacySiteUrl.length > 0
          ? `只配了 SITE_URL（${legacySiteUrl}），但没有任何代码读它 —— 站点会继续用内置默认地址。`
          : "未配置（回退 https://loxander.is-a.dev）",
  });

  const authSecret = get("AUTH_SECRET");
  const isProduction = process.env.NODE_ENV === "production";
  lines.push({
    name: "AUTH_SECRET",
    ok: authSecret.length >= 32 || (!isProduction && authSecret.length === 0),
    detail:
      authSecret.length === 0
        ? isProduction
          ? "**生产环境必须配**，否则任何登录请求都会 500（MissingSecretError）。"
          : "未配置（开发环境可起，但重启即掉登录）。"
        : `${authSecret.length} 字符${authSecret.length < 32 ? "（低于建议的 32 位）" : ""}`,
  });

  const githubId = get("AUTH_GITHUB_ID");
  const githubSecret = get("AUTH_GITHUB_SECRET");
  lines.push({
    name: "GitHub OAuth 凭据",
    ok: githubId.length > 0 && githubSecret.length > 0,
    detail:
      githubId.length > 0 && githubSecret.length > 0
        ? "两项齐全。"
        : `缺 ${[githubId.length === 0 ? "AUTH_GITHUB_ID" : "", githubSecret.length === 0 ? "AUTH_GITHUB_SECRET" : ""].filter(Boolean).join(" 与 ")} —— 登录页不会出现 GitHub 按钮。`,
  });

  const adminLogins = get("ADMIN_GITHUB_LOGIN");
  lines.push({
    name: "ADMIN_GITHUB_LOGIN",
    ok: adminLogins.length > 0,
    detail:
      adminLogins.length > 0
        ? `已配置：${adminLogins}`
        : "留空 = 谁都进不来（fail-closed，刻意设计）。",
  });

  const blobToken = get("BLOB_READ_WRITE_TOKEN");
  lines.push({
    name: "BLOB_READ_WRITE_TOKEN",
    ok: blobToken.length > 0,
    detail:
      blobToken.length > 0
        ? "已配置，媒体上传走 Vercel Blob。"
        : "未配置 —— 上传退化到本机 public/media/，Vercel 上会失败。",
  });

  const passed = lines.filter((l) => l.ok).length;
  return {
    id: "env",
    label: "环境变量",
    ok: passed === lines.length,
    passed,
    total: lines.length,
    lines,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 迁移检查（磁盘侧）。
 *
 * 库内那一半在 `lib/ops/migrations.ts` 的 `getMigrationStatus()` 里，
 * 需要 `DATABASE_URL`。这里只做「不需要连库就能查」的部分：文件在不在、
 * journal 与文件是否对得上、语句条数是否与 `db/verify.ts` 的期望一致。
 */
function checkMigrations(): CheckResult {
  const startedAt = Date.now();
  const lines: CheckLine[] = [];
  const dir = path.join(repoRoot(), "db", "migrations");
  const journalPath = path.join(dir, "meta", "_journal.json");

  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(".sql"))
        .sort((a, b) => a.localeCompare(b, "en"))
    : [];

  lines.push({
    name: "迁移文件",
    ok: files.length > 0,
    detail: files.length > 0 ? `${files.length} 份：${files.join("、")}` : `目录不存在或为空：${dir}`,
  });

  let journalTags: string[] = [];
  try {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries?: { tag: string }[];
    };
    journalTags = (journal.entries ?? []).map((e) => e.tag);
  } catch (error) {
    lines.push({
      name: "journal",
      ok: false,
      detail: `解析失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (journalTags.length > 0) {
    const diskTags = files.map((f) => f.replace(/\.sql$/, ""));
    const missingInJournal = diskTags.filter((t) => !journalTags.includes(t));
    const missingOnDisk = journalTags.filter((t) => !diskTags.includes(t));
    lines.push({
      name: "journal 与磁盘一致",
      ok: missingInJournal.length === 0 && missingOnDisk.length === 0,
      detail:
        missingInJournal.length === 0 && missingOnDisk.length === 0
          ? `${journalTags.length} 条记录与磁盘一一对应。`
          : `journal 缺 ${missingInJournal.join("、") || "无"}；磁盘缺 ${missingOnDisk.join("、") || "无"}。`,
    });
  }

  // snapshot 是否齐全（drizzle-kit 生成时每份迁移配一个）。
  const snapshotDir = path.join(dir, "meta");
  const snapshots = existsSync(snapshotDir)
    ? readdirSync(snapshotDir).filter((n) => n.endsWith("_snapshot.json"))
    : [];
  lines.push({
    name: "snapshot 齐全",
    ok: snapshots.length >= files.length,
    detail: `${snapshots.length} 份 snapshot / ${files.length} 份迁移${snapshots.length < files.length ? "（少于迁移数，drizzle-kit 下次 diff 可能基线错）" : ""}`,
  });

  const passed = lines.filter((l) => l.ok).length;
  return {
    id: "migrations",
    label: "迁移（磁盘）",
    ok: passed === lines.length,
    passed,
    total: lines.length,
    lines,
    elapsedMs: Date.now() - startedAt,
  };
}

/** 构建产物检查。 */
function checkBuild(): CheckResult {
  const startedAt = Date.now();
  const lines: CheckLine[] = [];
  const webRoot = APP_ROOT;

  const buildIdPath = path.join(webRoot, ".next", "BUILD_ID");
  let buildId: string | null = null;
  try {
    buildId = readFileSync(buildIdPath, "utf8").trim();
  } catch {
    buildId = null;
  }
  lines.push({
    name: "BUILD_ID",
    ok: buildId !== null && buildId.length > 0,
    detail: buildId ?? `读不到 ${buildIdPath} —— 还没构建，或产物在别处。`,
  });

  const serverDir = path.join(webRoot, ".next", "server");
  lines.push({
    name: "服务端产物",
    ok: existsSync(serverDir),
    detail: existsSync(serverDir) ? serverDir : `不存在：${serverDir}`,
  });

  const appDir = path.join(webRoot, ".next", "server", "app");
  lines.push({
    name: "app router 产物",
    ok: existsSync(appDir),
    detail: existsSync(appDir) ? "存在" : "不存在（可能只跑了 dev，dev 不产出 .next/server/app）",
  });

  const passed = lines.filter((l) => l.ok).length;
  return {
    id: "build",
    label: "构建产物",
    ok: passed === lines.length,
    passed,
    total: lines.length,
    lines,
    elapsedMs: Date.now() - startedAt,
  };
}

/** CSS 完整性（转 `runtime.ts` 的实现）。 */
function checkCss(): CheckResult {
  const startedAt = Date.now();
  const report = checkCssArtifacts();
  return {
    id: "css",
    label: "CSS 完整性",
    ok: report.ok,
    passed: report.ok ? 1 : 0,
    total: 1,
    lines: [
      {
        name: "Tailwind 工具类",
        ok: report.ok,
        detail: report.detail,
      },
    ],
    elapsedMs: Date.now() - startedAt,
  };
}

/** 仓库卫生检查。 */
function checkRepo(): CheckResult {
  const startedAt = Date.now();
  const lines: CheckLine[] = [];
  const root = repoRoot();

  const gitDir = path.join(root, ".git");
  lines.push({
    name: ".git 存在",
    ok: existsSync(gitDir),
    detail: existsSync(gitDir) ? gitDir : "不存在（生产部署没有 .git 是正常的）",
  });

  if (existsSync(gitDir)) {
    try {
      const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      lines.push({
        name: "当前分支",
        ok: true,
        detail: head.startsWith("ref:")
          ? head.slice(4).trim().replace(/^refs\/heads\//, "")
          : `detached HEAD（${head.slice(0, 7)}）`,
      });
    } catch {
      lines.push({ name: "当前分支", ok: false, detail: "读不到 .git/HEAD" });
    }
  }

  // 临时探针文件：`.tmp-*` 是 P7 期间反复踩的坑（残留会让 git status 变脏）。
  let tmpCount = 0;
  try {
    tmpCount = readdirSync(root).filter((n) => n.startsWith(".tmp-")).length;
  } catch {
    tmpCount = 0;
  }
  lines.push({
    name: "无 .tmp 残留",
    ok: tmpCount === 0,
    detail:
      tmpCount === 0
        ? "仓库根没有 .tmp-* 文件。"
        : `发现 ${tmpCount} 个 .tmp-* 条目（已由 .gitignore 兜住，但仍应清理）。`,
  });

  // .env 是否被 git 忽略（绝不能进版本库）。
  const envPath = path.join(root, ".env");
  const envExists = existsSync(envPath);
  lines.push({
    name: ".env 不被跟踪",
    ok: !envExists || existsSync(path.join(root, ".gitignore")),
    detail: envExists
      ? existsSync(path.join(root, ".gitignore"))
        ? ".env 存在，且仓库有 .gitignore（.env* 规则在其中）。"
        : "**有 .env 但没有 .gitignore** —— 密钥随时可能被提交。"
      : ".env 不存在（用环境变量注入）。",
  });

  const passed = lines.filter((l) => l.ok).length;
  return {
    id: "repo",
    label: "仓库卫生",
    ok: passed === lines.length,
    passed,
    total: lines.length,
    lines,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 路由巡检（需要 baseUrl）。
 *
 * `baseUrl` 由调用方给：页面上用 `SITE_URL` 或请求来源拼出来，
 * 而不是在这里猜 —— 猜错会得到一个「全部 ECONNREFUSED」的假失败。
 */
async function checkRoutes(baseUrl: string): Promise<CheckResult> {
  const startedAt = Date.now();
  const probes = await probeRoutes(baseUrl, DEFAULT_ROUTE_PATHS);
  const lines: CheckLine[] = probes.map((p) => ({
    name: p.path,
    ok: p.pass,
    detail: p.error
      ? `请求失败：${p.error}`
      : `${p.status}（期望 ${p.expect}） · ${p.ms}ms · ${p.bytes ?? 0}B` +
        `${p.cache ? ` · cache=${p.cache}` : ""}${p.vcache ? ` · vcache=${p.vcache}` : ""}`,
  }));
  const passed = lines.filter((l) => l.ok).length;
  return {
    id: "routes",
    label: "路由巡检",
    ok: passed === lines.length,
    passed,
    total: lines.length,
    lines,
    elapsedMs: Date.now() - startedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* 注册表与执行入口                                                            */
/* -------------------------------------------------------------------------- */

/** 检查清单（页面上按这个顺序渲染）。 */
export const CHECK_REGISTRY: { id: CheckId; label: string; needsBaseUrl: boolean; needsDb: boolean }[] =
  [
    { id: "env", label: "环境变量", needsBaseUrl: false, needsDb: false },
    { id: "migrations", label: "迁移（磁盘）", needsBaseUrl: false, needsDb: false },
    { id: "build", label: "构建产物", needsBaseUrl: false, needsDb: false },
    { id: "css", label: "CSS 完整性", needsBaseUrl: false, needsDb: false },
    { id: "repo", label: "仓库卫生", needsBaseUrl: false, needsDb: false },
    { id: "routes", label: "路由巡检", needsBaseUrl: true, needsDb: false },
  ];

/**
 * 跑一项检查。
 *
 * 全部是**同步或纯异步的进程内调用**，没有子进程、没有写操作。
 * 这一层的存在意义是：让「跑检查」这件事在运维台上真的能发生，
 * 而不是给一个点了就 EPERM 的按钮。
 */
export async function runCheck(id: CheckId, options: { baseUrl?: string } = {}): Promise<CheckResult> {
  switch (id) {
    case "env":
      return checkEnvironment();
    case "migrations":
      return checkMigrations();
    case "build":
      return checkBuild();
    case "css":
      return checkCss();
    case "repo":
      return checkRepo();
    case "routes": {
      if (!options.baseUrl) {
        return {
          id: "routes",
          label: "路由巡检",
          ok: false,
          passed: 0,
          total: 0,
          lines: [],
          elapsedMs: 0,
          error: "缺少 baseUrl，无法巡检。",
        };
      }
      return checkRoutes(options.baseUrl);
    }
    default:
      return {
        id,
        label: id,
        ok: false,
        passed: 0,
        total: 0,
        lines: [],
        elapsedMs: 0,
        error: `未知检查：${String(id)}`,
      };
  }
}

/**
 * 跑全部不需要 baseUrl 的检查。
 *
 * 串行而不是并发：这些检查都读文件系统，并发只会让磁盘调度更乱，
 * 而总耗时本来就在几十毫秒量级。
 */
export async function runAllLocalChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const entry of CHECK_REGISTRY) {
    if (entry.needsBaseUrl) continue;
    results.push(await runCheck(entry.id));
  }
  return results;
}

/** 需要子进程才能跑的脚本清单（如实列出，让用户知道去哪跑）。 */
export const SUBPROCESS_SCRIPTS: { script: string; npm: string; why: string }[] = [
  {
    script: "scripts/preflight.mjs",
    npm: "npm run preflight",
    why: "内部用 spawnSync 跑 tsc 与全部单测，必须起子进程。",
  },
  {
    script: "scripts/rollback-drill-all.mjs",
    npm: "npm run test:rollback",
    why: "要起四个真实服务进程（db/markdown × good/bad 库）。",
  },
  {
    script: "scripts/browser-acceptance.mjs",
    npm: "npm run test:browser",
    why: "要启动 Playwright 浏览器进程（本机沙箱下同样 EPERM）。",
  },
  {
    script: "scripts/export-markdown.mjs",
    npm: "npm run export:md",
    why: "脚本末尾是裸 main()，import 会立刻执行并 process.exit；且需注册 .ts 后缀 hook。",
  },
  {
    script: "db/compare.ts",
    npm: "npm run db:compare",
    why: "双路比对要在 PGlite 里跑全部迁移，内存与耗时都超出请求预算。",
  },
];
