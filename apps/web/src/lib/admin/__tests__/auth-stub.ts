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

export const FORBIDDEN_PATH = "/login?error=AccessDenied";
