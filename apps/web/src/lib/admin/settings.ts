import "server-only";

import {
  CONTENT_SOURCE_ENV,
  CONTENT_SOURCE_KINDS,
  DEFAULT_CONTENT_SOURCE,
} from "@/lib/content-source";

/**
 * 后台设置页（`/admin/settings`）的数据层：把「当前这台机器的运行配置是什么样」
 * 整理成可渲染的结构。**只读，不做任何写入或校验修复。**
 *
 * ── 为什么这一页不能编辑配置 ─────────────────────────────────────────
 * 方案 §13.5（`动态网站平台化执行方案.md:1084`）定的是「生产环境变量只在
 * Vercel 配置」。如果后台能改 `DATABASE_URL` 或 `AUTH_SECRET`，等于把
 * 「改一次环境变量」变成「一个普通后台账号就能把全站数据库指针指到别处」，
 * 而且改完的密钥会落到我们自己的库里 —— 那就不再是 §13.5 说的「只在 Vercel」了。
 * 所以这一页的定位是**运维自检面板**：告诉你现在是什么状态、缺什么、去哪补，
 * 但真正的修改动作留在 Vercel Project Settings → Environment Variables。
 *
 * ── 为什么不用 `resolveContentSourceKind()` 判非法值 ──────────────────
 * `lib/content-source.ts:172-184` 那个函数在取值非法时**抛异常**（刻意的：
 * 内容源配错必须让构建/请求直接失败，不能静默回退）。但自检面板恰恰要在
 * 「配置已经坏了」的时候还能打开并说清楚哪里坏了 —— 它自己抛异常就没法干活了。
 * 所以这里只用同一份枚举（`CONTENT_SOURCE_KINDS`）做自己的判定，不调用那个函数。
 * 枚举仍从 `content-source.ts` 导入而不是本地复制：取值列表只能有一个真相源，
 * 抄一份到这儿下次加第三种源就会漏。
 *
 * ── 为什么所有密钥都过 `maskSecret` ──────────────────────────────────
 * 这个文件的返回值**原样渲染到页面上**（`app/admin/settings/page.tsx` 直接
 * `{item.summary}`）。后台页面本身要过登录，但截图、录屏、贴给别人排查都可能泄露；
 * `DATABASE_URL` 里带着数据库密码，`AUTH_GITHUB_SECRET` / `BLOB_READ_WRITE_TOKEN`
 * 是可直接冒用的凭据。所以这里定一条硬规则：**本文件的任何 `summary` 字段
 * 都不允许出现完整的密钥原值**，要么经过 `maskSecret`，要么只输出长度。
 */

/** 环境变量的四种状态。 */
export type ConfigState = "ok" | "missing" | "weak" | "unused";

/** 一个配置项在页面上的呈现。 */
export interface ConfigItem {
  /** 环境变量名，例如 `DATABASE_URL`。 */
  key: string;
  /** 这个变量的作用，以及不配会怎样。 */
  purpose: string;
  state: ConfigState;
  /** **已脱敏**的当前值摘要。不要在这里放原值。 */
  summary: string;
  /** 可选的补充提示（排错建议、风险说明），没有就不渲染这一行。 */
  hint?: string;
}

/** 一个能力开关的呈现。 */
export interface CapabilityItem {
  name: string;
  enabled: boolean;
  /** 判定依据（哪个变量组合决定它），以及关闭时会发生什么。 */
  detail: string;
}

/** 整页的数据。 */
export interface SettingsReport {
  configs: ConfigItem[];
  capabilities: CapabilityItem[];
  environment: {
    nodeEnv: string;
    contentSource: string;
    version: string;
  };
}

/** `AUTH_SECRET` 的最短长度。低于它就是「能跑但薄」，见下方 hint。 */
const AUTH_SECRET_MIN_LENGTH = 32;

/** 版本号截断长度。与健康检查保持同一个口径（短 SHA 的通行长度）。 */
const VERSION_LENGTH = 7;

/** 读环境变量并去掉首尾空白。dotenv 的值常带行尾空格，直接比较会误判。 */
function readEnv(key: string): string {
  return (process.env[key] ?? "").trim();
}

/**
 * 把密钥变成「能贴到页面上」的字符串。
 *
 * ── 规则 ─────────────────────────────────────────────────────────────
 * ① 空字符串 → `未设置`（必须先判，否则会走到 `已设置（0 字符）` 那种蠢话）；
 * ② 能按 URL 解析且协议是 postgres/postgresql → `postgresql://用户名:***@主机`，
 *    保留用户名（排查「连错账号」时有用）、丢弃密码/路径/查询串
 *    （`?sslmode=require` 之类跟排查没关系，库名也不算敏感但没必要暴露）；
 * ③ 其他能解析的 URL → `协议//主机`；
 * ④ 解析不了（`vercel_blob_rw_xxx` 这种裸 token）→ 只报长度。
 *
 * ── 为什么用 `new URL()` 而不是正则 ──────────────────────────────────
 * 连接串里用户名可能含 `@`（URL 里会被百分号编码）、IPv6 主机带方括号、
 * 端口可有可无 —— 手写正则每个都要单独处理且容易漏一条导致整串漏输出。
 * `new URL()` 已经把 RFC 3986 的解析做完了，Node 24 上实测：
 * `postgresql://neondb_owner:abc123@ep-cool-1.neon.tech/neondb?sslmode=require`
 * 的 `username`/`password`/`host`/`pathname` 都能正确切出来。
 *
 * ── 兜底必须存在 ─────────────────────────────────────────────────────
 * `new URL("vercel_blob_rw_xxx")` 会抛 `TypeError`（没有冒号分隔的 scheme）。
 * 抛了就说明它不是 URL，走长度分支 —— 绝不能 `catch { return value }`，
 * 那样等于把密钥原样打到页面上。
 */
export function maskSecret(value: string): string {
  if (value.length === 0) {
    return "未设置";
  }

  try {
    const parsed = new URL(value);

    // 解析成功但拿不到主机（例如 `localhost:5432` 会被当成 scheme 为
    // `localhost:` 的 URL，host 为空）→ 这种既不是连接串也不是站点地址，
    // 按「不可识别」处理，只报长度，避免输出 `localhost://` 这种误导性内容。
    if (parsed.host.length === 0) {
      return `已设置（${value.length} 字符）`;
    }

    if (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") {
      // 用户名保留：Neon/Vercel 的报错里会带 role 名，对得上才看得出连的是谁。
      const credentials = parsed.username ? `${parsed.username}:***@` : "";
      return `${parsed.protocol}//${credentials}${parsed.host}`;
    }

    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return `已设置（${value.length} 字符）`;
  }
}

/** 解析 `ADMIN_GITHUB_LOGIN`，与 `lib/auth.ts:50-56` 的 `readAdminLogins()` 同一口径。 */
function parseAdminLogins(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** 判 `CONTENT_SOURCE` 是不是合法取值。空串算「没设置」，交给默认值。 */
function isKnownContentSource(value: string): boolean {
  return (CONTENT_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * 取当前部署的版本号。
 *
 * 只要 7 位是因为它只用来回答「线上跑的是哪一次提交」，
 * 完整 40 位贴在页面上没人会逐字比对，反而占地方。`dev` 是本地起的兜底值。
 */
function readVersion(): string {
  const sha = readEnv("VERCEL_GIT_COMMIT_SHA") || readEnv("GIT_COMMIT_SHA");
  return sha.length > 0 ? sha.slice(0, VERSION_LENGTH) : "dev";
}

/**
 * 生成整页报告。**纯读**：只碰 `process.env`，不查库、不写文件、不发请求。
 *
 * ── 为什么是同步函数 ─────────────────────────────────────────────────
 * 与页面上的用法对齐：这一页要能打开就说明「配置坏到哪种程度」，
 * 不能因为它自己去连一次数据库而卡住或报错（数据库恰好连不上时，
 * 这一页正是最该能打开的那一页）。所以所有判断都基于变量「有没有、长什么样」，
 * 真实连通性交给健康检查（`/api/health`）去答。
 */
export function buildSettingsReport(): SettingsReport {
  const isProduction = process.env.NODE_ENV === "production";

  const databaseUrl = readEnv("DATABASE_URL");
  const databaseConfigured = databaseUrl.length > 0;

  const rawContentSource = readEnv(CONTENT_SOURCE_ENV);
  const contentSourceIllegal =
    rawContentSource.length > 0 && !isKnownContentSource(rawContentSource);
  const contentSource = rawContentSource.length > 0 ? rawContentSource : DEFAULT_CONTENT_SOURCE;

  const authSecret = readEnv("AUTH_SECRET");
  const authSecretTooShort = authSecret.length > 0 && authSecret.length < AUTH_SECRET_MIN_LENGTH;

  const githubId = readEnv("AUTH_GITHUB_ID");
  const githubSecret = readEnv("AUTH_GITHUB_SECRET");

  const adminLogins = parseAdminLogins(readEnv("ADMIN_GITHUB_LOGIN"));

  const blobToken = readEnv("BLOB_READ_WRITE_TOKEN");

  // 站点地址：代码真正读的是 `NEXT_PUBLIC_SITE_URL`（`lib/site.ts:68`），
  // 而 `.env.example:30` 登记的是旧名 `SITE_URL`。两个都读，
  // 这样「按 .env.example 填了却不生效」这件事能在页面上被看见 —— 这正是自检的意义。
  const publicSiteUrl = readEnv("NEXT_PUBLIC_SITE_URL");
  const legacySiteUrl = readEnv("SITE_URL");

  const configs: ConfigItem[] = [
    {
      key: "DATABASE_URL",
      purpose:
        "Postgres 连接串（Neon）。后台内容列表、审计日志、媒体元数据，以及 P3 之后的公开站内容源都走它。",
      state: !databaseConfigured
        ? "missing"
        : isProduction && !databaseUrl.includes("sslmode")
          ? "weak"
          : "ok",
      summary: databaseConfigured ? maskSecret(databaseUrl) : "未设置",
      hint: !databaseConfigured
        ? "没有它后台列表页只会显示提示条，登录后也看不到任何内容。本地可用 `vercel env pull` 拉到真串。"
        : isProduction && !databaseUrl.includes("sslmode")
          ? "生产连接串建议带 `sslmode=require`（`.env.example:24` 的要求），否则连接可能被中间设备明文嗅探。"
          : undefined,
    },
    {
      key: CONTENT_SOURCE_ENV,
      purpose: `公开站内容从哪来：${CONTENT_SOURCE_KINDS.join(" / ")}。留空等于 ${DEFAULT_CONTENT_SOURCE}，回退路径始终保留。`,
      state: contentSourceIllegal ? "weak" : "ok",
      summary:
        rawContentSource.length === 0
          ? `未设置（默认 ${DEFAULT_CONTENT_SOURCE}）`
          : contentSourceIllegal
            ? `非法值：${rawContentSource}`
            : rawContentSource,
      hint: contentSourceIllegal
        ? `只接受 ${CONTENT_SOURCE_KINDS.join(" / ")}。取值非法时取数会直接抛错（不做静默回退），属于刻意行为。`
        : undefined,
    },
    {
      key: "SITE_URL",
      purpose:
        "站点绝对地址（sitemap、RSS、OAuth 回调拼接用）。注意：站点代码实际读的是 `NEXT_PUBLIC_SITE_URL`，回退值 `https://loxander.is-a.dev`。",
      state:
        publicSiteUrl.length > 0
          ? legacySiteUrl.length > 0
            ? "unused"
            : "ok"
          : legacySiteUrl.length > 0
            ? "unused"
            : "ok",
      summary:
        publicSiteUrl.length > 0
          ? `${publicSiteUrl}（来自 NEXT_PUBLIC_SITE_URL）`
          : legacySiteUrl.length > 0
            ? `${legacySiteUrl}（来自 SITE_URL）`
            : "未设置（回退 https://loxander.is-a.dev）",
      hint:
        legacySiteUrl.length > 0 && publicSiteUrl.length === 0
          ? "只配了 `SITE_URL`，但没有任何代码读它 —— 站点会继续用内置默认地址。请改配 `NEXT_PUBLIC_SITE_URL`。"
          : publicSiteUrl.length > 0 && legacySiteUrl.length > 0
            ? "`SITE_URL` 已被 `NEXT_PUBLIC_SITE_URL` 覆盖，当前不生效，可以从环境变量里删掉。"
            : undefined,
    },
    {
      key: "AUTH_SECRET",
      purpose:
        "Auth.js 的会话与 CSRF 签名密钥。生产环境缺它会直接抛 `MissingSecretError`，登录整个不可用。",
      state: !authSecret
        ? isProduction
          ? "missing"
          : "weak"
        : authSecretTooShort
          ? "weak"
          : "ok",
      summary: authSecret.length > 0 ? `已设置（${authSecret.length} 字符）` : "未设置",
      hint: !authSecret
        ? isProduction
          ? "生产环境必须配，否则任何登录请求都会 500（`MissingSecretError`）。用 `openssl rand -base64 32` 生成。"
          : "开发环境没配也能起来，但每次重启密钥都变 —— 表现就是「刷新页面就掉登录」。"
        : authSecretTooShort
          ? `只有 ${authSecret.length} 个字符，低于建议的 ${AUTH_SECRET_MIN_LENGTH} 位。建议换成 \`openssl rand -base64 32\` 的输出。`
          : undefined,
    },
    {
      key: "AUTH_GITHUB_ID",
      // GitHub OAuth App 的 Client ID 本来就会出现在浏览器可见的 authorize 跳转里，
      // 不是密钥，所以这一项直接显示原值 —— 排查 `redirect_uri_mismatch` 时要能
      // 跟 GitHub 后台的 App 逐字对照，遮起来反而没法核对。
      purpose:
        "GitHub OAuth App 的 Client ID。是公开标识不是密钥，所以这里显示原值，方便与 GitHub 后台逐字对照。",
      state: githubId.length > 0 ? "ok" : "missing",
      summary: githubId.length > 0 ? githubId : "未设置",
      hint:
        githubId.length > 0
          ? undefined
          : "没有它后台登录页不会出现 GitHub 登录按钮。创建 App 时回调地址填 `https://<站点域名>/api/auth/callback/github`，必须逐字符一致。",
    },
    {
      key: "AUTH_GITHUB_SECRET",
      purpose: "GitHub OAuth App 的 Client Secret，用来把授权码换成 token。**只显示长度，永远不回显。**",
      state: githubSecret.length > 0 ? "ok" : "missing",
      summary: githubSecret.length > 0 ? `已设置（${githubSecret.length} 字符）` : "未设置",
      hint:
        githubSecret.length > 0
          ? "方案 §13.5（`:1087`）要求定期轮换；轮换后旧 secret 立即失效，记得同步更新 Vercel。"
          : "没有它即使有 Client ID 也换不到 token，登录会停在回调页。",
    },
    {
      key: "ADMIN_GITHUB_LOGIN",
      purpose:
        "后台白名单：逗号或空格分隔的 GitHub 登录名（不是邮箱、不是显示名），大小写不敏感。空 = 谁都进不来（fail-closed）。",
      state: adminLogins.length > 0 ? "ok" : "missing",
      summary:
        adminLogins.length > 0
          ? `已配置 ${adminLogins.length} 个账号：${adminLogins.join("、")}`
          : "未设置",
      hint:
        adminLogins.length > 0
          ? undefined
          : "白名单为空时后台将无法登录 —— 这是刻意设计（`lib/auth.ts:50-56`、`:139`）。填上自己的 GitHub 登录名即可。",
    },
    {
      key: "BLOB_READ_WRITE_TOKEN",
      purpose:
        "Vercel Blob 读写令牌，媒体上传用。**只显示长度，永远不回显。**",
      state: blobToken.length > 0 ? "ok" : "missing",
      summary: blobToken.length > 0 ? `已设置（${blobToken.length} 字符）` : "未设置",
      hint:
        blobToken.length > 0
          ? "方案 §13.5（`:1087`）要求定期轮换。这里是读写令牌，泄露等于别人可以覆盖/删除所有图片。"
          : "未配置时上传会退化到 `apps/web/public/media/`，本地能用；Vercel 上文件系统只读，上传会失败。",
    },
  ];

  const githubLoginEnabled =
    githubId.length > 0 && githubSecret.length > 0 && adminLogins.length > 0;

  const capabilities: CapabilityItem[] = [
    {
      name: "数据库",
      enabled: databaseConfigured,
      detail: databaseConfigured
        ? "已配置 DATABASE_URL，后台内容/审计可查库。判据与 `lib/admin/db.ts:96` 的 `hasDatabaseUrl()` 一致。"
        : "未配置 DATABASE_URL：后台列表页只显示提示条，内容管理与审计日志均不可用。",
    },
    {
      name: "db 内容源",
      enabled: contentSource === "db",
      detail:
        contentSource === "db"
          ? "公开站正从 Postgres 的 `entries` 表读内容（`lib/sources/db.ts`）。"
          : `公开站正从仓库里的 markdown 文件读内容（\`lib/sources/markdown.ts\`），当前取值 ${contentSource}。`,
    },
    {
      name: "GitHub 登录",
      enabled: githubLoginEnabled,
      detail: githubLoginEnabled
        ? `Client ID / Client Secret / 白名单（${adminLogins.length} 个账号）三项齐全。`
        : "需要 AUTH_GITHUB_ID、AUTH_GITHUB_SECRET、ADMIN_GITHUB_LOGIN 三项同时存在；缺任何一项都会导致登录不可用或无人可进。",
    },
    {
      name: "媒体上传到 Blob",
      enabled: blobToken.length > 0,
      detail:
        blobToken.length > 0
          ? "上传走 `https://<store>.public.blob.vercel-storage.com/media/...`，与本机磁盘无关。"
          : "上传退化到本地 `apps/web/public/media/`。本地可用；Vercel 只读文件系统上会失败。",
    },
    {
      name: "草稿在开发环境可见",
      enabled: !isProduction,
      detail: isProduction
        ? "当前是生产环境：只展示 publish_status = 'published' 的条目（判据 `lib/sources/db.ts:190-193` 的 `visibleOnly()`）。"
        : "当前不是生产环境：草稿也会出现在站点上。判据见 `lib/sources/db.ts:184-192` 的 `includeDrafts`，与 `lib/posts.ts:27`、`lib/diary.ts:25` 相同。",
    },
  ];

  return {
    configs,
    capabilities,
    environment: {
      nodeEnv: process.env.NODE_ENV ?? "未设置",
      contentSource: contentSourceIllegal ? `${rawContentSource}（非法）` : contentSource,
      version: readVersion(),
    },
  };
}
