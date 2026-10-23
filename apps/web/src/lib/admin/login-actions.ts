"use server";

import { signIn } from "../auth";

/**
 * 登录动作（Server Action）。
 *
 * 为什么不直接把 `signIn` 导出给客户端组件用：
 * `next-auth` 导出的 `signIn` 在服务端调用时会抛 `NEXT_REDIRECT`，必须由
 * Server Action 或 Route Handler 承载；直接在 Client Component 里
 * `import { signIn } from "next-auth/react"` 是另一条完全不同的路径
 * （走 /api/auth 的 POST），两者混用会让 CSRF 校验和回调地址计算出现分歧。
 * 这里统一走服务端那条。
 *
 * `redirectTo` 指向 `/admin`：登录校验（白名单）在 `callbacks.signIn` 里做，
 * 不在白名单的用户根本走不到这个 redirect —— `@auth/core` 会抛
 * `AccessDenied` 并把请求打到 `pages.signIn` + `?error=AccessDenied`。
 */
export async function signInWithGitHubAction(): Promise<void> {
  await signIn("github", { redirectTo: "/admin" });
}
