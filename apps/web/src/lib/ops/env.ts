import "server-only";

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSettingsReport, maskSecret, type SettingsReport } from "@/lib/admin/settings";

/**
 * 环境与外部平台状态。
 *
 * ── 环境矩阵直接复用 `lib/admin/settings.ts` ──────────────────────────
 * 那一份 `buildSettingsReport()` 已经把「每个变量干什么、现在是什么状态、
 * 缺了会怎样」写全了（还带 `SITE_URL` vs `NEXT_PUBLIC_SITE_URL` 这种
 * 「配了但没人读」的判定）。运维台再抄一份必然漂移 —— 两个页面说两套话
 * 是排查时最坏的体验。所以这里只做转发，并**额外**补两件它不做的事：
 * ① 可用性总判定（哪些外部平台能查）；② Vercel / Neon 的实时状态。
 *
 * ── 密钥的规矩不变 ────────────────────────────────────────────────────
 * 任何返回值都会被渲染到页面上，所以只允许出现 `maskSecret()` 的结果
 * 或纯长度。Vercel / Neon 的 token 本身**永远不出现在返回值里**。
 */

/* -------------------------------------------------------------------------- */
/* 环境矩阵                                                                    */
/* -------------------------------------------------------------------------- */

/** 环境矩阵（转发 `buildSettingsReport`，附一份可用性判定）。 */
export interface EnvMatrix {
  report: SettingsReport;
  /** 外部平台可用性。 */
  platforms: {
    vercel: { available: boolean; reason: string; tokenSource: string };
    neon: { available: boolean; reason: string; tokenSource: string };
  };
}

/** 本机 Vercel CLI 的凭据文件路径（`vercel login` 写在这里）。 */
const VERCEL_CLI_AUTH = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "com.vercel.cli",
  "Data",
  "auth.json",
);

/**
 * 找 Vercel token。
 *
 * 两级来源，顺序有意义：
 * 1. `process.env.VERCEL_TOKEN` —— 显式配置，线上/CI 的唯一正道。
 * 2. 本机 Vercel CLI 的 `auth.json` —— **只在非 Vercel 运行时**读。
 *
 * 为什么允许第 2 级：本机开发时用户已经 `vercel login` 过，凭据就在盘上，
 * 再让人手工把 token 抄进 `.env` 是纯粹的无用功。但这必须严格限制在
 * 「非 Vercel 运行时」：线上函数里根本没有那个文件，而且线上绝不该
 * 依赖运维者本机的登录态。
 *
 * ── 这个函数的返回值里带 token 原文 ──────────────────────────────────
 * 所以**它只允许被 `getVercelStatus()` 内部调用**，绝不能被页面直接渲染。
 * 返回的 `source` 是给人看的来源说明（不含 token）。
 */
function resolveVercelToken(): { token: string | null; source: string } {
  const fromEnv = (process.env.VERCEL_TOKEN ?? "").trim();
  if (fromEnv.length > 0) return { token: fromEnv, source: "环境变量 VERCEL_TOKEN" };

  const onVercel = process.env.VERCEL === "1" || process.env.VERCEL === "true";
  if (onVercel) return { token: null, source: "未配置（线上不读本机 CLI 凭据）" };

  try {
    if (!existsSync(VERCEL_CLI_AUTH)) return { token: null, source: "未配置" };
    const raw = JSON.parse(readFileSync(VERCEL_CLI_AUTH, "utf8")) as { token?: string };
    const token = typeof raw.token === "string" ? raw.token.trim() : "";
    return token.length > 0
      ? { token, source: "本机 Vercel CLI 登录态（auth.json）" }
      : { token: null, source: "未配置（auth.json 里没有 token）" };
  } catch {
    return { token: null, source: "未配置（auth.json 读取失败）" };
  }
}

/** 组装环境矩阵。 */
export function getEnvMatrix(): EnvMatrix {
  const report = buildSettingsReport();
  const vercel = resolveVercelToken();
  const neonKey = (process.env.NEON_API_KEY ?? "").trim();

  return {
    report,
    platforms: {
      vercel: {
        available: vercel.token !== null,
        reason: vercel.token !== null ? "" : "没有可用的 Vercel token，无法查询项目与部署。",
        tokenSource: vercel.source,
      },
      neon: {
        available: neonKey.length > 0,
        reason:
          neonKey.length > 0
            ? ""
            : "未配置 NEON_API_KEY。数据库本身是否连通请用「健康检查」，它不需要这个 key。",
        tokenSource: neonKey.length > 0 ? "环境变量 NEON_API_KEY" : "未配置",
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Vercel                                                                      */
/* -------------------------------------------------------------------------- */

/** 一次 Vercel 部署。 */
export interface VercelDeployment {
  id: string;
  url: string | null;
  state: string;
  target: string | null;
  createdAt: number;
  commitSha: string | null;
  commitMessage: string | null;
}

/** Vercel 项目状态。 */
export interface VercelStatus {
  ok: boolean;
  project: { id: string; name: string; framework: string | null; rootDirectory: string | null } | null;
  /** Git 集成类型：`github` 表示 push 会自动部署，`none` 表示不会（P8 踩过）。 */
  linkType: string | null;
  domains: string[];
  deployments: VercelDeployment[];
  error?: string;
}

/**
 * 查 Vercel 项目与最近部署。
 *
 * ── 为什么单独把 `linkType` 提出来 ────────────────────────────────────
 * P8 期间真实踩过：新项目的 `link.type` 是 `none`，于是 `git push` **不会
 * 触发部署**，而所有本地验收全绿。当时的症状是「线上 `/api/health`
 * 的 version 停在 5e8bc96，而本地 HEAD 已经是 6d2adee」。
 * 所以这个字段必须显式呈现，不能混在「部署列表」里。
 *
 * 项目 id 与 team id 从环境变量读，没有就用 P8 记录里的实测值。
 */
export async function getVercelStatus(): Promise<VercelStatus> {
  const { token } = resolveVercelToken();
  if (!token) {
    return {
      ok: false,
      project: null,
      linkType: null,
      domains: [],
      deployments: [],
      error: "没有可用的 Vercel token。",
    };
  }

  const teamId = (process.env.VERCEL_TEAM_ID ?? "").trim();
  const projectId = (process.env.VERCEL_PROJECT_ID ?? "").trim();
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";

  const call = async <T>(pathname: string): Promise<T> => {
    const response = await fetch(`https://api.vercel.com${pathname}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`${pathname} → HTTP ${response.status} ${await response.text().catch(() => "")}`.trim());
    }
    return (await response.json()) as T;
  };

  try {
    // 没有配 projectId 时，用「列项目」反查：本项目名字固定是 loxander-platform。
    let resolvedProjectId = projectId;
    let project: VercelStatus["project"] = null;
    let linkType: string | null = null;
    let domains: string[] = [];

    if (resolvedProjectId) {
      const detail = await call<{
        id: string;
        name: string;
        framework?: string | null;
        rootDirectory?: string | null;
        link?: { type?: string } | null;
        targets?: Record<string, unknown>;
      }>(`/v9/projects/${resolvedProjectId}${query}`);
      project = {
        id: detail.id,
        name: detail.name,
        framework: detail.framework ?? null,
        rootDirectory: detail.rootDirectory ?? null,
      };
      linkType = detail.link?.type ?? null;

      const domainList = await call<{ domains?: { name: string }[] }>(
        `/v9/projects/${resolvedProjectId}/domains${query}`,
      ).catch(() => ({ domains: [] }));
      domains = (domainList.domains ?? []).map((d) => d.name);
    } else {
      const list = await call<{
        projects?: {
          id: string;
          name: string;
          framework?: string | null;
          rootDirectory?: string | null;
          link?: { type?: string } | null;
        }[];
      }>(`/v9/projects${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""}`);
      const found = (list.projects ?? []).find((p) => p.name === "loxander-platform");
      if (found) {
        resolvedProjectId = found.id;
        project = {
          id: found.id,
          name: found.name,
          framework: found.framework ?? null,
          rootDirectory: found.rootDirectory ?? null,
        };
        linkType = found.link?.type ?? null;
      }
    }

    if (!resolvedProjectId) {
      return {
        ok: false,
        project: null,
        linkType: null,
        domains: [],
        deployments: [],
        error: "Vercel 上找不到名为 loxander-platform 的项目。",
      };
    }

    const deployList = await call<{
      deployments?: {
        uid: string;
        url?: string;
        state?: string;
        target?: string | null;
        created?: number;
        meta?: Record<string, string>;
      }[];
    }>(`/v6/deployments?projectId=${encodeURIComponent(resolvedProjectId)}&limit=5${teamId ? `&teamId=${encodeURIComponent(teamId)}` : ""}`);

    const deployments: VercelDeployment[] = (deployList.deployments ?? []).map((d) => ({
      id: d.uid,
      url: d.url ?? null,
      state: d.state ?? "UNKNOWN",
      target: d.target ?? null,
      createdAt: d.created ?? 0,
      commitSha: d.meta?.githubCommitSha?.slice(0, 7) ?? null,
      commitMessage: d.meta?.githubCommitMessage ?? null,
    }));

    return { ok: true, project, linkType, domains, deployments };
  } catch (error) {
    return {
      ok: false,
      project: null,
      linkType: null,
      domains: [],
      deployments: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Neon                                                                        */
/* -------------------------------------------------------------------------- */

/** Neon 项目/分支/计算节点状态。 */
export interface NeonStatus {
  ok: boolean;
  project: { id: string; name: string; region: string | null; pgVersion: number | null } | null;
  branches: { id: string; name: string; primary: boolean }[];
  endpoints: {
    id: string;
    host: string;
    type: string;
    /** `active` / `idle` —— Neon 的 scale-to-zero 会让冷启动变慢。 */
    currentState: string;
  }[];
  error?: string;
}

/**
 * 查 Neon 控制面。
 *
 * ── 为什么需要它（数据库连通性已经有健康检查了）────────────────────
 * 健康检查答的是「现在能不能连」。Neon 特有的一类问题是「为什么慢」：
 * 计算节点 scale-to-zero 后第一次连接要冷启动 3–4 秒（P8 期间实测
 * 出现过 `read ECONNRESET`，靠 `connect_timeout: 20` + 三次重试才稳住）。
 * `endpoints[].currentState` 能直接看出「是不是正在冷启动」。
 */
export async function getNeonStatus(): Promise<NeonStatus> {
  const key = (process.env.NEON_API_KEY ?? "").trim();
  if (key.length === 0) {
    return {
      ok: false,
      project: null,
      branches: [],
      endpoints: [],
      error: "未配置 NEON_API_KEY。",
    };
  }

  const call = async <T>(pathname: string): Promise<T> => {
    const response = await fetch(`https://console.neon.tech/api/v2${pathname}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`${pathname} → HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  };

  try {
    const projects = await call<{
      projects?: { id: string; name: string; region_id?: string; pg_version?: number }[];
    }>("/projects");

    const project = (projects.projects ?? [])[0];
    if (!project) {
      return { ok: false, project: null, branches: [], endpoints: [], error: "Neon 账号下没有项目。" };
    }

    const branches = await call<{ branches?: { id: string; name: string; primary?: boolean }[] }>(
      `/projects/${project.id}/branches`,
    );
    const endpoints = await call<{
      endpoints?: { id: string; host: string; type: string; current_state?: string }[];
    }>(`/projects/${project.id}/endpoints`);

    return {
      ok: true,
      project: {
        id: project.id,
        name: project.name,
        region: project.region_id ?? null,
        pgVersion: project.pg_version ?? null,
      },
      branches: (branches.branches ?? []).map((b) => ({
        id: b.id,
        name: b.name,
        primary: b.primary === true,
      })),
      endpoints: (endpoints.endpoints ?? []).map((e) => ({
        id: e.id,
        host: e.host,
        type: e.type,
        currentState: e.current_state ?? "unknown",
      })),
    };
  } catch (error) {
    return {
      ok: false,
      project: null,
      branches: [],
      endpoints: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 把连接串里的敏感部分遮掉（导出给页面用，避免各页面自己写一套）。 */
export { maskSecret };
