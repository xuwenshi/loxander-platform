/**
 * 应用根目录解析 —— 纯函数，无副作用（只读 `fs.existsSync`）。
 *
 * ── 这个文件解决的问题：生产模式下 markdown 内容源整个读不到 ─────────────
 * 四个旧 lib 一直用 `path.join(process.cwd(), "content", ...)` 定位内容：
 * - `lib/posts.ts:24`    `BLOG_DIR`
 * - `lib/diary.ts:22`    `DIARY_DIR`
 * - `lib/goals.ts:25`    `GOALS_DIR`
 * - `lib/projects.ts:18` `PROJECTS_DIR`
 * 另有 `lib/posts.ts:61` 与 `:113` 用 `process.cwd()` + `public/`。
 *
 * 本地单元测试一直显式 `process.chdir(WEB_DIR)`（`p3-wiring.test.ts:76` 等）
 * 来迁就这个假设，所以测试全绿。但**生产启动时没有人 chdir**：
 * 实测 `node scripts/next-local-start.mjs` 下
 * ```
 * process.cwd()                     = ...\loxander-platform      ← 仓库根
 * cwd/content/blog 存在              = false
 * cwd/apps/web/content/blog 存在     = true
 * ```
 * 于是 `listPostFiles()` 走 `if (!fs.existsSync(BLOG_DIR)) return []` 的兜底分支，
 * 永远返回空数组。预渲染过的页面由构建产物直接服务，看不出问题；
 * **请求时才渲染的路径会全部塌掉**，实测两条独立证据：
 *
 * 1. 搜索（`/search?q=markdown`，方案 §14.2 规定的动态查询）
 *    ```
 *    markdown + cwd=仓库根    → 200  52312B  命中 0 篇
 *    markdown + cwd=apps/web  → 200  73349B  命中 2 篇  ← 正确答案
 *    db       + cwd=仓库根    → 200  64952B  命中 2 篇  ← db 源不读文件，不受影响
 *    ```
 *    0 篇时连空态提示都不渲染，用户看到的是「搜了但什么都没有」。
 * 2. 不存在 slug 的 404 判定（`getPost(slug)` 恒返回 `null`）
 *    详见 `lib/proxy-rules.ts` 文件头。
 *
 * ── 为什么不用 `import.meta.url` / `__dirname` ──────────────────────
 * 这两个值会被打包器按 chunk 位置重算，`apps/web/src/lib/` 与最终
 * `.next/server/chunks/` 的层级关系不稳定，跨 bundler 版本容易静默错位。
 * 而「候选目录里哪个真的含 `content/blog`」是一个可以当场验证的事实，
 * 不依赖任何打包假设 —— 错了会立刻退化为旧行为，不会更糟。
 *
 * ── 为什么候选顺序是 cwd 优先 ───────────────────────────────────────
 * 部署形态有两种真实存在：
 * - Vercel：Root Directory 设成 `apps/web`，`process.cwd()` 就是应用根 → 第一候选命中
 * - 本地 / 自托管从 monorepo 根启动 → 第一候选落空，第二候选命中
 * 把 cwd 放第一，保证「本来就是对的」那些部署零行为变化。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 判定一个目录像不像「应用根」：必须同时有 `content/` 与 `package.json`。
 *
 * 只认 `content/` 不够 —— monorepo 根也曾经有过同名目录的诱惑；
 * 加上 `package.json` 是为了把「仓库根」与「apps/web」区分开。
 */
function looksLikeAppRoot(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, "content"))) return false;
  return fs.existsSync(path.join(dir, "package.json"));
}

/**
 * 应用根目录的绝对路径。
 *
 * 候选（按优先级）：
 * 1. `process.cwd()` —— 标准 `next start` / Vercel（Root Directory = apps/web）
 * 2. `process.cwd()/apps/web` —— 从 monorepo 根启动（本机 `scripts/next-local-start.mjs`）
 *
 * 两个都不像时**退回 `process.cwd()`**：让调用方维持改动前的行为，
 * 而不是抛错导致站点起不来。内容读不到是降级，起不来是事故。
 */
export const APP_ROOT: string = (() => {
  const cwd = process.cwd();
  const candidates = [cwd, path.join(cwd, "apps", "web")];
  for (const candidate of candidates) {
    if (looksLikeAppRoot(candidate)) return candidate;
  }
  return cwd;
})();

/**
 * 内容目录（`content/blog` 等）的绝对路径。
 *
 * @param kind 目录名，如 `"blog"` / `"diary"` / `"goals"` / `"projects"`
 */
export function contentDir(kind: string): string {
  return path.join(APP_ROOT, "content", kind);
}

/**
 * `public/` 下某个相对路径的绝对路径。
 *
 * @param relativePath 以 `/` 开头的公开路径（如 `/images/cover.svg`）
 */
export function publicPath(relativePath: string): string {
  return path.join(APP_ROOT, "public", relativePath);
}
