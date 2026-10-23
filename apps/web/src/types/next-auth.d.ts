import type { DefaultSession } from "next-auth";

/**
 * 给 `session.user` 补两个字段。
 *
 * `lib/auth.ts` 的 `callbacks.session` 会写 `session.user.id` 与
 * `session.user.githubLogin`，但 Auth.js 的 `Session["user"]` 默认只有
 * `name / email / image`（见 `@auth/core/types.d.ts` 的 `DefaultSession`）。
 * 不在这里声明，TypeScript 会在 `lib/auth.ts` 与所有后台页面上报
 * 「属性 id 不存在于类型 …」。
 *
 * 注意声明的是 `next-auth` 模块而不是 `@auth/core`：
 * `next-auth/index.d.ts` 把 `Session` 从 `@auth/core/types` re-export 出来，
 * 而 `next-auth` 自己暴露的是同名 module augmentation 点（Auth.js v5 官方做法）。
 */
declare module "next-auth" {
  interface Session {
    user: {
      /** `users.id`（uuid）。后台按 created_by 过滤与审计写 actor_id 都要用。 */
      id: string;
      /** GitHub 用户名（小写）。白名单校验与后台展示用。 */
      githubLogin: string | null;
    } & DefaultSession["user"];
  }
}
