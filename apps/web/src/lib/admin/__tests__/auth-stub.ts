/**
 * P4 离线测试的 `../auth` 替身。
 *
 * ── 为什么必须打桩 ────────────────────────────────────────────────────
 * `lib/admin/actions.ts` 第一步就是 `requireAdmin()`，而真实的 `requireAdmin()`
 * 会调 `auth()` → `next-auth` 的 `getSession()` → 读 `next/headers` 的 cookie。
 * 纯 node 里没有请求上下文，这条链路必然抛错 —— 于是所有 Server Action 都测不了。
 *
 * 但「有没有登录」不是 P4 要验的东西（那是 Auth.js 的事），P4 要验的是
 * **登录之后那七道关**：校验、乐观锁、事务、审计、缓存失效。
 * 所以这里把身份换成可注入的变量，让测试能把注意力放在写路径上。
 *
 * ── 白名单逻辑不在替身里复制 ──────────────────────────────────────────
 * 替身**故意不实现**白名单判断（那是 `lib/auth.ts` 的职责，改了应该让那边红）。
 * 这里只做两件事：给一个可注入的管理员身份；模拟「没有身份就抛错」。
 */

/** 一个固定 uuid，方便断言 `created_by` / `actor_id`。 */
export const ADMIN_USER_ID = "11111111-1111-4111-8111-111111111111";

export interface StubAdmin {
  id: string;
  githubLogin: string | null;
}

let currentAdmin: StubAdmin | null = {
  id: ADMIN_USER_ID,
  githubLogin: "tester",
};

/** 设置当前身份；传 `null` 模拟未登录。 */
export function setCurrentAdmin(next: StubAdmin | null): void {
  currentAdmin = next;
}

/** 与真实实现同样的错误文案，方便断言「拒绝」这条路。 */
export async function requireAdmin(): Promise<StubAdmin> {
  if (!currentAdmin) {
    throw new Error("[auth] 未登录，拒绝后台写操作。");
  }
  return currentAdmin;
}

export async function getAdminSession(): Promise<{ user: StubAdmin } | null> {
  return currentAdmin ? { user: currentAdmin } : null;
}

/**
 * 登出链路的调用序记录。
 *
 * ── 这条为什么值得单独测 ──────────────────────────────────────────────
 * `events.signOut` 拿不到 userId（`@auth/core` 的 `deleteSession` 契约是
 * `void`，drizzle adapter 也照此实现，事件里的 `message.session` 恒为
 * `undefined`），所以「登出审计」必须在 `signOut()` **之前**写，否则
 * sessions 行已经没了、审计也拿不到 actor。
 *
 * 这不是靠代码读出来的结论 —— 是 2026-10-23 验收时在 `audit_logs` 里真的
 * 抓到一行 `action='auth.sign_out', actor_id=null, entity_id=null` 才发现的。
 * 所以这里把「先记录、后登出」的顺序变成可断言的。
 */
export const signOutSequence: string[] = [];

/** 清空调用序，每个用例开头调一次。 */
export function resetSignOutSequence(): void {
  signOutSequence.length = 0;
}

export async function recordSignOutBeforeClearing(): Promise<void> {
  signOutSequence.push(currentAdmin ? `audit:${currentAdmin.id}` : "audit:none");
}

export async function signOut(options?: { redirectTo?: string }): Promise<void> {
  signOutSequence.push(`signOut:${options?.redirectTo ?? ""}`);
}

export const FORBIDDEN_PATH = "/login?error=AccessDenied";
