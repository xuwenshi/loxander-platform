"use server";

import { headers } from "next/headers";

import { signIn } from "../auth";
import { checkRateLimit, rateLimitKey } from "../rate-limit";

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
 *
 * ── 为什么这里要接限流 ────────────────────────────────────────────────
 * 这是全站**唯一一个不需要任何凭据就能触发外部 OAuth 往返**的入口。不设限时，
 * 一个脚本可以无限次把站点推进 GitHub 授权跳转：每次都会新建 state / PKCE 记录、
 * 打一次 GitHub 的 `/authorize`，并且让 `audit_logs`（如果开了失败审计）迅速膨胀。
 * 属于方案 §15.1 里「登录失败率」这一监控项的对应防线。
 *
 * 阈值比健康检查严得多，因为两者的正常基数完全不同：
 * - 健康检查：监控系统按分钟级拉取，正常流量是「持续且低」；
 * - 登录：真人一分钟最多点一两次，且连续 10 次失败基本可以判定不是手滑。
 * 5 分钟 10 次给了「输错密码重试几次」的余量（本项目其实没有密码，
 * 但 OAuth 往返失败、点了取消、开错浏览器都要重试），又远低于脚本刷的量级。
 */

/** 登录限流窗口：5 分钟。 */
const LOGIN_RATE_LIMIT_WINDOW_MS = 5 * 60_000;

/** 窗口内允许的登录发起次数。 */
const LOGIN_RATE_LIMIT = 10;

/**
 * 限流 scope。与健康检查的 `"health"`、媒体上传的 `"media-upload"` 互不相同 ——
 * 共用 scope 会让两个入口共享一个桶，打健康检查能把人锁在登录外面。
 */
const LOGIN_RATE_LIMIT_SCOPE = "login";

/**
 * 超限时抛出的受控错误文案。
 *
 * 抽成常量是为了让测试能断言「错误里含『过于频繁』」而不必复制整条中文串 ——
 * 文案是产品决策，测试只关心语义。
 */
const LOGIN_TOO_FREQUENT_MESSAGE = "登录尝试过于频繁，请 5 分钟后再试。";

/**
 * 发起 GitHub 登录（Server Action）。
 *
 * 限流必须在 `signIn()` **之前**：`signIn` 一旦被调用就开始 OAuth 往返，
 * 之后再判断已经晚了（外部请求已经打出去了）。
 *
 * ── 为什么超限时抛错，而不是 `redirect()` 或返回错误对象 ──────────────
 * 1. **不能 `redirect()`**：Server Action 里 `redirect()` 是靠抛一个特殊错误
 *    （`NEXT_REDIRECT`）实现的，它会掩盖真正的失败原因；而且把用户导去一个
 *    「登录失败」页面，用户看到的仍然不是「你点太快了」。更糟的是，
 *    `redirect()` 在 `try/catch` 里会被当成普通错误吞掉，是很常见的翻车点。
 * 2. **不能返回错误对象**：本函数的返回类型是 `Promise<void>`，调用方是
 *    `<form action={signInWithGitHubAction}>`。`<form action={fn}>` 只接受
 *    返回 `void` 的函数，返回的对象会被静默丢弃 —— 等于限流生效了但用户
 *    完全看不出来，只会觉得「点了没反应」。要用返回值就必须改成
 *    `useActionState`，那会连带改登录页组件，超出本次接线范围。
 * 3. **抛错**是唯一「不改调用方也能让用户看见」的路径：Next 会把 Server Action
 *    抛出的错误交给最近的 `error.tsx` / `global-error.tsx` 边界渲染。
 *
 * 这是 P5 的**既定取舍**：错误呈现是 error boundary 的通用样式，不是登录页
 * 专属的友好提示。更细的错误 UI（原地提示「请 5 分钟后再试」而不跳错误页）
 * 留给 P6，那时需要把这里改成「返回结果 + 登录页用 useActionState 消费」。
 *
 * ── 为什么不会挡住已登录用户 ──────────────────────────────────────────
 * 限流只在这个「发起登录」的 action 里。后台访问的守卫是
 * `apps/web/src/lib/auth.ts` 的 `requireAdmin()`，它在每次后台写操作时
 * 自己调 `auth()` 读已有会话，**完全不经过本文件**。所以一个已经登录的
 * 管理员把登录配额耗尽，也不会影响他进后台 —— 只会影响他重新登录。
 * 换句话说：最坏情况是「自己把自己锁在门外 5 分钟」，而不是「把站内功能锁死」。
 */
export async function signInWithGitHubAction(): Promise<void> {
  // `headers()` 在 Next 15+ 是异步的（Cache Components 下必须 await）。
  const requestHeaders = await headers();

  const limited = checkRateLimit(rateLimitKey(LOGIN_RATE_LIMIT_SCOPE, requestHeaders), {
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
    limit: LOGIN_RATE_LIMIT,
  });

  if (!limited.ok) {
    // 故意不带任何「还剩几次 / 什么时候可以再试」的细节：这条消息会直接
    // 渲染进 error boundary，而 error boundary 的页面是可能被截图转发的。
    // 窗口长度（5 分钟）写死进文案是安全的，它不是安全边界。
    throw new Error(LOGIN_TOO_FREQUENT_MESSAGE);
  }

  await signIn("github", { redirectTo: "/admin" });
}
