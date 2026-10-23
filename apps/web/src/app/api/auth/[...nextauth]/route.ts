import { handlers } from "@/lib/auth";

/**
 * Auth.js 的 HTTP 入口。
 *
 * `handlers` 里的 GET / POST 都由 `next-auth` 提供（见 `next-auth/index.js`：
 * `httpHandler = (req) => Auth(reqWithEnvURL(req), config)`），这里只做 re-export，
 * 不写任何逻辑 —— 任何一行自定义代码都会成为「认证绕过」的候选面。
 *
 * 路径是 `/api/auth/*`：`@auth/core` 的 basePath 默认值就是 `/api/auth`
 * （`node_modules/@auth/core/lib/utils/env.js`：`config.basePath || (config.basePath = "/api/auth")`），
 * 放在 `app/api/auth/[...nextauth]/route.ts` 正好对上，不需要额外配置。
 *
 * 注意 `apps/web/src/proxy.ts` 的 matcher 是 `/((?!_next/|api/|.*\..*).*)`，
 * 也就是 `/api/*` 已被排除 —— 这是**故意的**：Auth.js 的回调要自己处理
 * 自己的错误页与重定向，proxy 插一脚会破坏 CSRF 校验。
 */
export const { GET, POST } = handlers;
