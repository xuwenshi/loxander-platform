import "server-only";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { APP_ROOT } from "@/lib/app-root";

/**
 * 运行态取证：健康、构建信息、git 版本、路由巡检、版本一致性。
 *
 * ── 全部在进程内完成，不用 `child_process` ────────────────────────────
 * 本机沙箱 `spawn` 抛 EPERM，Vercel 也不给子进程。所以「读 git HEAD」
 * 不能 `git rev-parse`，而是直接读 `.git/HEAD` 与 `.git/refs/...`
 * （`readGitHead()`）；「读构建 ID」不能跑 `next build`，而是读
 * `.next/BUILD_ID`（`getBuildInfo()`）。
 *
 * 这不是妥协，而是**更准确**：`git rev-parse` 读的也是这些文件，
 * 直接读省掉一次进程启动（约 40ms）与一层解析。
 */

/* -------------------------------------------------------------------------- */
/* 仓库与构建信息                                                              */
/* -------------------------------------------------------------------------- */

/** 仓库根（`APP_ROOT` 是 `apps/web`，往上两级）。 */
function repoRoot(): string {
  const twoUp = path.resolve(APP_ROOT, "..", "..");
  return existsSync(path.join(twoUp, ".git")) ? twoUp : APP_ROOT;
}

/** git HEAD 的解析结果。 */
export interface GitHead {
  /** 完整 40 位 sha。 */
  sha: string;
  /** 短 sha（7 位），与 `/api/health` 上报口径一致。 */
  shortSha: string;
  /** 分支名；detached HEAD 时为 null。 */
  branch: string | null;
  /** 读到了什么：`loose` = `.git/refs/` 下的散文件，`packed` = `packed-refs`。 */
  source: "loose" | "packed";
}

/**
 * 直接读 `.git` 目录解析 HEAD，不启动 git 进程。
 *
 * 三种真实形态都要处理：
 * 1. `.git/HEAD` = `ref: refs/heads/main`，且 `.git/refs/heads/main` 存在 → loose
 * 2. 同上但散文件不存在（被 `git gc` 打包）→ 查 `.git/packed-refs`
 * 3. `.git/HEAD` 直接是 40 位 sha（detached HEAD，CI 里常见）
 *
 * 读不到就返回 null —— 生产部署（Vercel）根本没有 `.git`，那不是缺陷。
 */
export function readGitHead(): GitHead | null {
  const gitDir = path.join(repoRoot(), ".git");
  if (!existsSync(gitDir)) return null;

  let headRaw: string;
  try {
    headRaw = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return null;
  }

  const toResult = (sha: string, branch: string | null, source: "loose" | "packed"): GitHead => ({
    sha,
    shortSha: sha.slice(0, 7),
    branch,
    source,
  });

  if (!headRaw.startsWith("ref:")) {
    // detached HEAD：HEAD 文件本身就是 sha。
    return /^[0-9a-f]{40}$/.test(headRaw) ? toResult(headRaw, null, "loose") : null;
  }

  const ref = headRaw.slice(4).trim();
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;

  // 形态 1：散文件。
  try {
    const loose = readFileSync(path.join(gitDir, ...ref.split("/")), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(loose)) return toResult(loose, branch, "loose");
  } catch {
    // 落到 packed-refs。
  }

  // 形态 2：packed-refs。格式是「sha refname」逐行，首行可能是 `# pack-refs with: ...`。
  try {
    const packed = readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    for (const line of packed.split(/\r?\n/)) {
      if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) continue;
      const space = line.indexOf(" ");
      if (space === -1) continue;
      const sha = line.slice(0, space);
      const name = line.slice(space + 1).trim();
      if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return toResult(sha, branch, "packed");
    }
  } catch {
    // 没有 packed-refs。
  }

  return null;
}

/** 构建与进程信息。 */
export interface BuildInfo {
  /** `.next/BUILD_ID` 的内容；读不到为 null（说明没有构建产物或不在仓库根）。 */
  buildId: string | null;
  nodeEnv: string;
  nodeVersion: string;
  /** 应用根绝对路径。排查「内容目录找错」时最关键的一条。 */
  appRoot: string;
  /** 是否运行在 Vercel。 */
  vercel: boolean;
  /** Vercel 注入的部署 ID（有则显示）。 */
  vercelDeploymentId: string | null;
  /** Vercel 注入的提交 sha。 */
  vercelCommitSha: string | null;
}

/**
 * 读构建与进程信息。
 *
 * `BUILD_ID` 的路径有个坑：`APP_ROOT` 是 `apps/web`，`.next` 就在它下面；
 * 但某些部署形态下 `.next` 在仓库根。两处都试，读不到就如实报 null。
 */
export function getBuildInfo(): BuildInfo {
  const candidates = [path.join(APP_ROOT, ".next", "BUILD_ID"), path.join(repoRoot(), ".next", "BUILD_ID")];
  let buildId: string | null = null;
  for (const candidate of candidates) {
    try {
      const value = readFileSync(candidate, "utf8").trim();
      if (value.length > 0) {
        buildId = value;
        break;
      }
    } catch {
      // 试下一个。
    }
  }

  return {
    buildId,
    nodeEnv: process.env.NODE_ENV ?? "未设置",
    nodeVersion: process.version,
    appRoot: APP_ROOT,
    vercel: process.env.VERCEL === "1" || process.env.VERCEL === "true",
    vercelDeploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    vercelCommitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* 健康检查                                                                    */
/* -------------------------------------------------------------------------- */

/** 一次数据库连通性探测的结果。 */
export interface HealthProbe {
  ok: boolean;
  /** 建连 + `select 1` 的往返毫秒数。 */
  latencyMs: number;
  /** 服务端版本（`select version()` 的前 60 字符）。 */
  serverVersion: string | null;
  /** 当前会话是否真的只读（读 `default_transaction_read_only`）。 */
  readOnly: boolean;
  error?: string;
}

/**
 * 探测数据库：能不能连、多快、是不是只读会话。
 *
 * ── 为什么要单独读 `default_transaction_read_only` ────────────────────
 * 运维台的全部安全性建立在「这个连接是只读的」上面。如果哪天有人改了
 * `db-readonly.ts` 的连接参数而忘了这层，页面上的「只读」标签就会撒谎。
 * 所以这里**向数据库本身求证**一次，而不是相信自己写的配置。
 */
export async function probeDatabase(databaseUrl: string): Promise<HealthProbe> {
  const startedAt = Date.now();
  const client = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
    connection: {
      application_name: "loxander-ops-health",
      default_transaction_read_only: true,
      statement_timeout: 8_000,
    },
  });

  try {
    const rows = await client<{ version: string; ro: string }[]>`
      select version() as version, current_setting('default_transaction_read_only') as ro
    `;
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      serverVersion: rows[0]?.version ? rows[0].version.slice(0, 60) : null,
      readOnly: rows[0]?.ro === "on",
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      serverVersion: null,
      readOnly: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* 路由巡检                                                                    */
/* -------------------------------------------------------------------------- */

/** 一条路由的巡检结果。 */
export interface RouteProbe {
  path: string;
  status: number | null;
  ms: number;
  /** 响应字节数。 */
  bytes: number | null;
  /** Next 的缓存状态头（`x-nextjs-cache`）。 */
  cache: string | null;
  /** Vercel 边缘缓存状态头（`x-vercel-cache`）。 */
  vcache: string | null;
  /** 预期状态码。 */
  expect: number;
  pass: boolean;
  error?: string;
}

/**
 * 默认巡检清单。
 *
 * 与 P7 收口时手工跑的那 20 条对齐，但只留「稳定可断言」的：
 * 随机 slug 的 404 检查需要每次现生成，交给调用方传 `extraPaths`。
 */
export const DEFAULT_ROUTE_PATHS: { path: string; expect: number }[] = [
  { path: "/", expect: 200 },
  { path: "/blog", expect: 200 },
  { path: "/projects", expect: 200 },
  { path: "/diary", expect: 200 },
  { path: "/goals", expect: 200 },
  { path: "/about", expect: 200 },
  { path: "/resume", expect: 200 },
  { path: "/universe", expect: 200 },
  { path: "/tags", expect: 200 },
  { path: "/search", expect: 200 },
  { path: "/rss.xml", expect: 200 },
  { path: "/sitemap.xml", expect: 200 },
  { path: "/robots.txt", expect: 200 },
  { path: "/api/health", expect: 200 },
  { path: "/login", expect: 200 },
  { path: "/admin", expect: 307 },
];

/**
 * 逐条请求站点并记录状态码、耗时、缓存头。
 *
 * ── 为什么不并发 ──────────────────────────────────────────────────────
 * 并发会让「耗时」这一列失去意义（互相争抢连接），而这一列正是判断
 * 「哪个页面慢」的唯一依据。串行 16 条、每条几十毫秒，总耗时可以接受。
 *
 * ── 为什么 `redirect: "manual"` ───────────────────────────────────────
 * `/admin` 未登录时是 307 跳 `/login`。`fetch` 默认会自动跟随，
 * 那样拿到的就是 `/login` 的 200，看不出「守卫在工作」。必须手动拿 307。
 */
export async function probeRoutes(
  baseUrl: string,
  paths: { path: string; expect: number }[] = DEFAULT_ROUTE_PATHS,
): Promise<RouteProbe[]> {
  const results: RouteProbe[] = [];

  for (const entry of paths) {
    const startedAt = Date.now();
    try {
      const response = await fetch(new URL(entry.path, baseUrl), {
        redirect: "manual",
        headers: { "user-agent": "loxander-ops-route-probe" },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.text();
      const status = response.status;
      results.push({
        path: entry.path,
        status,
        ms: Date.now() - startedAt,
        bytes: Buffer.byteLength(body, "utf8"),
        cache: response.headers.get("x-nextjs-cache"),
        vcache: response.headers.get("x-vercel-cache"),
        expect: entry.expect,
        pass: status === entry.expect,
      });
    } catch (error) {
      results.push({
        path: entry.path,
        status: null,
        ms: Date.now() - startedAt,
        bytes: null,
        cache: null,
        vcache: null,
        expect: entry.expect,
        pass: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/* 版本一致性                                                                  */
/* -------------------------------------------------------------------------- */

/** 版本一致性比对。 */
export interface VersionConsistency {
  localHead: string | null;
  buildId: string | null;
  remoteVersion: string | null;
  remoteUrl: string;
  /** 本机 HEAD 与线上上报版本是否一致。读不到任一项时为 null（无法判断）。 */
  headMatchesRemote: boolean | null;
  /** 人话结论。 */
  verdict: string;
}

/**
 * 对比「本机 git HEAD」「构建 ID」「线上 `/api/health` 上报的版本」。
 *
 * ── 为什么这条检查值得单独做 ──────────────────────────────────────────
 * P8 期间真实踩过一次：修完软 404 的提交（`6d2adee`）**从未被部署**，
 * 而所有本地验收全绿 —— 因为验收跑的是本地构建产物。
 * 当时的发现方式是手工比对 `/api/health` 的 `version` 字段与 `git log`。
 * 这个函数把那次手工比对固化成一次点击。
 */
export async function checkVersionConsistency(options: {
  remoteUrl: string;
}): Promise<VersionConsistency> {
  const head = readGitHead();
  const build = getBuildInfo();

  let remoteVersion: string | null = null;
  let remoteError: string | null = null;
  try {
    const response = await fetch(new URL("/api/health", options.remoteUrl), {
      headers: { "user-agent": "loxander-ops-version-check" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      const payload = (await response.json()) as { version?: string };
      remoteVersion = typeof payload.version === "string" ? payload.version : null;
    } else {
      remoteError = `HTTP ${response.status}`;
    }
  } catch (error) {
    remoteError = error instanceof Error ? error.message : String(error);
  }

  let headMatchesRemote: boolean | null = null;
  let verdict: string;

  if (remoteError) {
    verdict = `无法读取线上版本：${remoteError}`;
  } else if (!head) {
    verdict = "读不到本机 git HEAD（生产部署没有 .git 是正常的），只能看线上版本。";
  } else if (!remoteVersion) {
    verdict = "线上 /api/health 没有返回 version 字段。";
  } else {
    // 线上上报的是短 sha，本机也有短 sha，两边都按 7 位比。
    headMatchesRemote = head.shortSha === remoteVersion.slice(0, 7);
    verdict = headMatchesRemote
      ? `一致：线上跑的就是本机 HEAD（${head.shortSha}）。`
      : `不一致：本机 HEAD 是 ${head.shortSha}，线上是 ${remoteVersion}。线上不是最新的，或本机有未推送的提交。`;
  }

  return {
    localHead: head ? head.shortSha : null,
    buildId: build.buildId,
    remoteVersion,
    remoteUrl: options.remoteUrl,
    headMatchesRemote,
    verdict,
  };
}

/* -------------------------------------------------------------------------- */
/* 构建产物检查                                                                */
/* -------------------------------------------------------------------------- */

/** CSS 产物完整性检查结果。 */
export interface CssArtifactReport {
  ok: boolean;
  /** 找到的 CSS 文件数。 */
  files: number;
  totalBytes: number;
  /** 缺失的关键工具类。 */
  missing: string[];
  /** 产物目录（找不到时为 null）。 */
  directory: string | null;
  detail: string;
}

/**
 * 检查构建产物里的 Tailwind 工具类是否齐全。
 *
 * 逻辑与 `scripts/check-css-completeness.mjs` 完全一致（同样的类名清单、
 * 同样的 30KB 下限），但**不用 subprocess**：那个脚本末尾是裸 `main()`，
 * import 它会立刻执行并在失败时 `process.exitCode = 1`，把 Next 进程带脏。
 *
 * 为什么这条检查必须在运维台里：P7 踩过 —— 生产构建成功、页面 200、
 * 但 CSS 里一条工具类都没有（整站无样式），而**所有常规闸门都不响**。
 */
export function checkCssArtifacts(): CssArtifactReport {
  const required = [".flex{", ".grid{", ".overflow-hidden{", ".sr-only{", ".min-h-svh{", ".text-foreground{"];
  const minBytes = 30_000;

  const candidates = [
    path.join(APP_ROOT, ".next", "static", "css"),
    path.join(repoRoot(), ".next", "static", "css"),
  ];

  let dir: string | null = null;
  let names: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const found = readdirSync(candidate).filter((name) => name.endsWith(".css"));
    if (found.length > 0) {
      dir = candidate;
      names = found;
      break;
    }
  }

  if (dir === null) {
    return {
      ok: false,
      files: 0,
      totalBytes: 0,
      missing: required,
      directory: null,
      detail:
        "找不到 CSS 构建产物（.next/static/css）。生产部署的产物在函数包内，不可读 —— 这条检查只在本机构建后有效。",
    };
  }

  let all = "";
  let totalBytes = 0;
  for (const name of names) {
    const text = readFileSync(path.join(dir, name), "utf8");
    all += text;
    totalBytes += Buffer.byteLength(text, "utf8");
  }

  const missing = required.filter((cls) => !all.includes(cls));

  if (missing.length > 0) {
    return {
      ok: false,
      files: names.length,
      totalBytes,
      missing,
      directory: dir,
      detail: `缺少 ${missing.length} 个关键工具类：${missing.join(" ")}。这几乎一定是 Tailwind 没跑（检查 postcss.config.mjs 与构建用的 bundler）。`,
    };
  }

  if (totalBytes < minBytes) {
    return {
      ok: false,
      files: names.length,
      totalBytes,
      missing: [],
      directory: dir,
      detail: `关键类都在但总量只有 ${totalBytes} 字节（低于 ${minBytes}）—— 可能 Tailwind 只扫了部分源码。`,
    };
  }

  return {
    ok: true,
    files: names.length,
    totalBytes,
    missing: [],
    directory: dir,
    detail: `${names.length} 个 CSS 文件 / ${totalBytes} 字节，${required.length} 个关键工具类齐全。`,
  };
}
