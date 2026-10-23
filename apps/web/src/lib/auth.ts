import "server-only";

import NextAuth, { type NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";

import { accounts, sessions, users, verificationTokens, auditLogs } from "../../../../db/schema";
import { getAdminDb, hasDatabaseUrl } from "./admin/db";

/**
 * Auth.js 配置 —— 后台唯一的身份来源。
 *
 * ── 四条硬约束（方案 §8.4 / §9.1 / §13）─────────────────────────────
 *
 * 1. **白名单在 `callbacks.signIn` 里判，不能在 `events.signIn` 里判。**
 *    读 `node_modules/@auth/core/lib/actions/callback/index.js` 的 OAuth 分支：
 *      :63-67  handleAuthorized(callbacks.signIn)
 *      :70     handleLoginOrRegister(...)   ← 建用户 / 建 session
 *      :103-113 database 策略写 session cookie
 *      :114-119 events.signIn                ← cookie 已经发出去了
 *    在 events 里拒绝，会话 cookie 已经在浏览器里了，等于没有拒绝。
 *    `callbacks.signIn` 返回 false 时 `handleAuthorized` 抛 `AccessDenied`，
 *    整个回调链中断，**一行 session 都不会写**。
 *
 * 2. **GitHub 的 `login` 字段不会自动落到 user 上。**
 *    `node_modules/@auth/core/providers/github.js` 的 `profile()` 只返回
 *    `{ id, name, email, image }`。所以要拿 `login` 只能在 `callbacks.signIn`
 *    的 `params.profile.login` 上读 —— 好在 `GitHubProfile` 有这个字段。
 *    白名单因此**只依赖 profile**，不依赖数据库状态。
 *
 * 3. **默认 session callback 会把 user 裁成 `{name, email, image}`。**
 *    见 `node_modules/@auth/core/lib/init.js` 的 `defaultCallbacks.session`。
 *    后台列表要按 `created_by = session.user.id` 过滤、审计要写 actor_id，
 *    所以必须自定义 `callbacks.session` 把 `id` 与 `github_login` 放回去。
 *
 * 4. **`AUTH_SECRET` 缺失时必须报错，不能静默生成随机密钥。**
 *    `node_modules/@auth/core/lib/utils/env.js` 的 setEnvDefaults 只负责把
 *    env 灌进 config，不会替你造密钥；生产下 @auth/core 会抛 MissingSecretError。
 *    dev 下没有 secret 也能跑（登录会失败），但那样「登录不了」和「白名单拒了」
 *    在页面上长得一样。所以这里主动在 dev 缺失时打一条明确告警。
 *
 * ── 为什么用「函数式 config」而不是直接传对象 ─────────────────────────
 * adapter 需要 `getAdminDb()`，它是 async（要先读 env、惰性建连接池）。
 * NextAuth 函数式 config 允许在每次请求时异步构造配置，正好匹配。
 * 代价：`setEnvDefaults` 每次都会被调用一次（上游设计如此，无副作用）。
 */

/** 从 `ADMIN_GITHUB_LOGIN` 解析白名单（支持逗号/空格分隔多个账号）。 */
function readAdminLogins(): string[] {
  const raw = process.env.ADMIN_GITHUB_LOGIN ?? "";
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** 登录失败/成功都会落到 `/login`，所以这里只需要它存在。 */
const SIGN_IN_PAGE = "/login";

/** 白名单外的人被踢回这里 —— 与「请先登录」区分开，避免用户反复重试。 */
export const FORBIDDEN_PATH = "/login?error=AccessDenied";

/**
 * 写一条审计日志。
 *
 * 刻意**吞掉所有异常**：审计写失败不该让「已经成功发布的内容」回滚，
 * 也不该让一次登录变成 500。失败时 console.error 留痕，由人去看日志。
 */
async function writeAudit(entry: {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const db = await getAdminDb();
    await db.insert(auditLogs).values({
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      detail: entry.detail ?? {},
    });
  } catch (error) {
    console.error("[auth] 审计日志写入失败：", error);
  }
}

export const authConfig: NextAuthConfig = {
  // 有 adapter 时 @auth/core 默认就是 "database"；写出来是为了不让它随版本默认值变化。
  session: { strategy: "database" },

  providers: [
    // 不传参数：@auth/core 的 setEnvDefaults 会按 provider id 自动读
    // AUTH_GITHUB_ID / AUTH_GITHUB_SECRET（见 @auth/core/lib/utils/env.js）。
    GitHub({
      authorization: {
        // 只要读权限。后台不调用 GitHub API 写任何东西，
        // 但 email 与 login 必须拿到（login 用于白名单，email 用于 users.email）。
        params: { scope: "read:user user:email" },
      },
      // @auth/core 的 normalizeOAuth 对 OAuth provider 默认只开 ["pkce"]
      // （node_modules/@auth/core/lib/utils/providers.js:52 `const checks = c.checks ?? ["pkce"]`），
      // 只有配了 redirectProxyUrl 才会自动补 "state"。我们没配代理，
      // 所以默认情况下 authorize 请求里根本不带 state 参数，回调也不校验 state。
      //
      // PKCE 本身已经能挡住"拿别人 code 来换 token"，但 state 是 OAuth 2.0 对
      // 登录 CSRF 的既定要求，且成本为零：显式打开后回调端会走
      // o.validateAuthResponse(..., state)（callback/oauth/callback.js:93），
      // 缺 state 或 state 不匹配一律 fail-closed。线下全往返已验：
      // 带 state 正常登录，去掉 state 参数则报 `response parameter "state" missing`。
      checks: ["pkce", "state"],
    }),
  ],

  pages: { signIn: SIGN_IN_PAGE },

  // 后台是单人站点：cookie 名保持默认（authjs.session-token / __Secure- 前缀由
  // useSecureCookies 自动加），不自定义以免和 CSRF cookie 前缀规则打架。
  useSecureCookies: process.env.NODE_ENV === "production",

  callbacks: {
    /**
     * 第 2 道关：管理员白名单。
     *
     * 返回 false → @auth/core 抛 AccessDenied，会话不建立。
     * 返回字符串 → 重定向到该 URL。
     * 返回 true / undefined → 放行。
     */
    signIn({ profile, account }) {
      const adminLogins = readAdminLogins();

      // 没配白名单 = 后台完全关闭。这是刻意的 fail-closed：
      // 漏配一个环境变量不应该等于「任何人都能进后台」。
      if (adminLogins.length === 0) {
        console.error(
          "[auth] 未配置 ADMIN_GITHUB_LOGIN，后台登录已被拒绝。" +
            "请在环境变量里填 GitHub 用户名（逗号分隔多个）。",
        );
        return false;
      }

      const login =
        typeof profile?.login === "string" ? profile.login.toLowerCase() : undefined;

      if (!login) {
        console.error(
          "[auth] 登录回调里拿不到 GitHub login（provider =",
          account?.provider,
          "），无法校验白名单，拒绝登录。",
        );
        return false;
      }

      if (!adminLogins.includes(login)) {
        console.warn(`[auth] 拒绝非管理员登录：github login = ${login}`);
        return false;
      }

      return true;
    },

    /**
     * 把 id 与 github_login 放进 session.user。
     *
     * database 策略下 `params.user` 是 `users` 表整行（见
     * @auth/core/lib/actions/session.js 的 getSessionAndUser 分支），
     * 所以能直接读到非 Auth.js 标准字段 `github_login`。
     */
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        session.user.githubLogin = (user as { github_login?: string | null }).github_login ?? null;
      }
      return session;
    },
  },

  events: {
    /**
     * 登录成功后：补 `users.github_login`，写审计日志。
     *
     * 注意这个事件的时机 —— 会话 cookie 已经写了（见文件头第 1 条）。
     * 所以这里**只做记录，不做拒绝**。
     */
    async signIn({ user, account, profile, isNewUser }) {
      const login =
        typeof (profile as { login?: unknown } | undefined)?.login === "string"
          ? ((profile as { login: string }).login)
          : null;

      // 白名单里已经保证 login 存在，但 adapter 在极端情况下可能复用旧行，
      // 所以这里仍然做一次条件更新，避免把 NULL 盖成 NULL。
      if (login && user.id) {
        try {
          const db = await getAdminDb();
          await db
            .update(users)
            .set({ github_login: login })
            .where(eq(users.id, user.id));
        } catch (error) {
          console.error("[auth] 更新 github_login 失败：", error);
        }
      }

      await writeAudit({
        actorId: user.id ?? null,
        action: "auth.sign_in",
        entityType: "user",
        entityId: user.id,
        detail: { provider: account?.provider ?? null, login, isNewUser: Boolean(isNewUser) },
      });
    },

    async signOut(message) {
      // ── 为什么这里拿不到 userId，以及为什么改成「查会话表」─────────────
      // database 策略下 `@auth/core/lib/actions/signout.js` 的顺序是：
      //   const session = await options.adapter?.deleteSession(sessionToken);
      //   await events.signOut?.({ session });
      // 看起来事件里能拿到会话行 —— 但 **`deleteSession` 的返回值契约是 `void`**
      // （`@auth/core/adapters.d.ts`），而 `@auth/drizzle-adapter/lib/pg.js` 的实现
      // 也确实只 `await client.delete(...)`、不 returning，所以 `session` 恒为
      // `undefined`。之前的写法 `(sessionRow as {userId?})?.userId` 永远取到 null，
      // 结果是 2026-10-23 验收时在 `audit_logs` 里抓到一行
      // `action='auth.sign_out', actor_id=null, entity_id=null` —— 审计等于没记。
      //
      // 修法：**在 signOut 之前**先自己查一次会话表拿到 userId（见下方
      // `recordSignOutBeforeClearing`），由 `adminSignOutAction` 调用。
      // 这里只作为兜底：如果上游将来真的把 session 传进来，就照常用。
      const sessionRow = "session" in message ? message.session : undefined;
      const userId =
        (sessionRow as { userId?: string } | null | undefined)?.userId ?? null;
      if (!userId) {
        // 兜底路径也不会写一行全 null 的垃圾审计 —— 那比没有更糟（看着像记录，
        // 实际无法追责）。改为明确报错，让「没记上」这件事本身可见。
        console.error(
          "[auth] signOut 事件拿不到 userId（adapter.deleteSession 无返回值），" +
            "本条登出未写审计。请确认登出入口调用的是 adminSignOutAction。",
        );
        return;
      }
      await writeAudit({
        actorId: userId,
        action: "auth.sign_out",
        entityType: "user",
        entityId: userId,
      });
    },
  },
};

/**
 * 惰性构造最终配置：每次请求时把数据库连接塞进 adapter。
 *
 * 用函数式 config 的原因见文件头「为什么用函数式 config」。
 */
export const { handlers, auth, signIn, signOut } = NextAuth(async (): Promise<NextAuthConfig> => {
  // 没有 DATABASE_URL 时不要在这里抛 —— 让 `auth()` 返回 null、由页面显示
  // 「后台未配置数据库」，比整个 /login 500 更可诊断。
  if (!hasDatabaseUrl()) {
    console.error("[auth] 缺少 DATABASE_URL，后台登录不可用。");
    return { ...authConfig, providers: [] };
  }

  const db = await getAdminDb();

  if (process.env.NODE_ENV !== "production" && !process.env.AUTH_SECRET) {
    console.warn(
      "[auth] dev 环境未设置 AUTH_SECRET。@auth/core 会自行处理，" +
        "但生产环境必须显式配置，否则 NextAuth 会抛 MissingSecretError。",
    );
  }

  return {
    ...authConfig,
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
  };
});

/** 当前登录者是否为管理员（白名单已在登录时校验过，这里只看会话存在性）。 */
export async function getAdminSession() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session;
}

/**
 * 登出前补写审计。
 *
 * ── 为什么需要这个函数 ────────────────────────────────────────────────
 * `events.signOut` 拿不到 userId：`@auth/core` 的 `deleteSession` 返回值契约
 * 是 `void`，drizzle adapter 也照此实现，所以事件里的 `message.session` 恒为
 * `undefined`（详见 `callbacks.signIn` 下方 `signOut` 的注释）。等 `signOut()`
 * 调用返回时，sessions 行**已经被删了**，再查就查不到。
 *
 * 所以必须**在 signOut 之前**把会话取出来。`adminSignOutAction` 负责调用本函数。
 *
 * 只写 `auth.sign_out`，且只写一条；拿不到 userId 时什么都不写（宁缺勿造
 * 一行全 null 的假记录）。
 */
export async function recordSignOutBeforeClearing(): Promise<void> {
  const session = await getAdminSession();
  const userId = session?.user?.id;
  if (!userId) return;
  await writeAudit({
    actorId: userId,
    action: "auth.sign_out",
    entityType: "user",
    entityId: userId,
    detail: { githubLogin: session.user.githubLogin ?? null },
  });
}

/**
 * Server Action 里用的强制校验。
 *
 * 对应方案 §8.4 第 1、2 道关，以及 Next 16 proxy 文档的警告
 * （`proxy.md:249-251`：Server Function 不是独立路由，proxy matcher 排除的
 * 路径上 proxy 不会拦 Server Function，所以**每个 action 必须自己再校验一次**）。
 *
 * 抛错而不是返回 null：调用方忘了判空也不会把写操作执行下去。
 */
export async function requireAdmin(): Promise<{ id: string; githubLogin: string | null }> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error("[auth] 未登录，拒绝后台写操作。");
  }

  // 会话存在不等于还在白名单里 —— 管理员把某个 GitHub 账号从
  // ADMIN_GITHUB_LOGIN 删掉后，他已有的 session 还活着。所以每次都重查。
  const adminLogins = readAdminLogins();
  const login = session.user.githubLogin?.toLowerCase() ?? "";

  if (adminLogins.length === 0 || !adminLogins.includes(login)) {
    throw new Error("[auth] 当前账号不在管理员白名单内，拒绝后台写操作。");
  }

  return { id: userId, githubLogin: login };
}
