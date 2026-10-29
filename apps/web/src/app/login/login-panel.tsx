import { GithubIcon } from "@/components/ui/Icons";

import { signInWithGitHubAction } from "@/lib/admin/login-actions";

/**
 * 登录面板。
 *
 * ── 为什么是 Server Component ───────────────────────────────────────
 * 登录只有一个动作（点按钮 → POST 到 GitHub），没有本地状态，不需要客户端
 * JS。用 `<form action={serverAction}>` 让浏览器直接提交，即使 JS 没加载完
 * 也能登录 —— 这是登录页最该保证的可用性。
 *
 * ── 错误码翻译 ─────────────────────────────────────────────────────
 * 只认识 Auth.js 会真正返回的两个：
 * - `AccessDenied`：`callbacks.signIn` 返回 false（不在 `ADMIN_GITHUB_LOGIN` 白名单）。
 * - `Configuration`：缺 `AUTH_GITHUB_ID/SECRET`，或者 provider 配错。
 * 其余一律显示通用文案，避免把内部错误码暴露给未登录者。
 */
export function LoginPanel({ error }: { error: string | null }) {
  return (
    <div className="rounded-2xl border border-border bg-elevated p-8">
      <h1 className="font-serif text-lg font-medium tracking-tight text-foreground">后台登录</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        使用 GitHub 账号登录。只有管理员名单内的账号可以进入。
      </p>

      {error ? <ErrorNotice code={error} /> : null}

      <form action={signInWithGitHubAction} className="mt-6">
        <button
          type="submit"
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]"
        >
          <GithubIcon width={16} height={16} />
          用 GitHub 登录
        </button>
      </form>

      <p className="mt-6 text-xs leading-relaxed text-muted">
        登录成功后会写入一个 HttpOnly 会话 Cookie。如果这里提示无权访问，说明
        你的 GitHub 用户名不在服务端的 <code className="font-mono">ADMIN_GITHUB_LOGIN</code>{" "}
        名单里 —— 需要改环境变量，不能在前端绕过。
      </p>
    </div>
  );
}

/** 把 Auth.js 的错误码翻成人话。 */
function ErrorNotice({ code }: { code: string }) {
  if (code === "AccessDenied") {
    return (
      <p
        role="alert"
        className="mt-4 rounded-xl border border-error/40 bg-error/10 px-3 py-2.5 text-sm leading-relaxed text-error"
      >
        该 GitHub 账号不在管理员名单内，已拒绝登录。如需授权，请让维护者把用户名加入{" "}
        <code className="font-mono">ADMIN_GITHUB_LOGIN</code>。
      </p>
    );
  }

  if (code === "Configuration") {
    return (
      <p
        role="alert"
        className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm leading-relaxed text-warning"
      >
        登录服务未正确配置（缺少 AUTH_SECRET 或 GitHub OAuth 凭据）。这是服务端问题，
        请联系维护者，刷新重试不会解决。
      </p>
    );
  }

  return (
    <p
      role="alert"
      className="mt-4 rounded-xl border border-error/40 bg-error/10 px-3 py-2.5 text-sm leading-relaxed text-error"
    >
      登录失败，请重试。如果持续失败，请联系维护者查看服务端日志。
    </p>
  );
}
