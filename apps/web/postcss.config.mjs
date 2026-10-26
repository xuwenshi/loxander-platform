/**
 * PostCSS 配置 —— 只为 **Webpack 构建路径** 服务。
 *
 * ── 为什么需要这个文件（P7 收口时发现的真实缺陷）────────────────────
 * 本项目把 Tailwind 接在 `next.config.ts` 的 `turbopack.rules` 里：
 *
 *   turbopack: { rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } } }
 *
 * 这条规则**只对 Turbopack 生效**。而 `scripts/next-local-build.mjs` 为了绕开
 * 沙箱的子进程限制，用的是 Webpack（`bundler = 1`）。Webpack 路径下没有任何
 * 东西去跑 Tailwind —— 结果生产构建产出的 CSS 里**一条工具类都没有**
 * （实测 `apps/web/.next/static/css/*.css` 里 `.flex` `.relative` `.overflow-hidden`
 * `.min-w-*` `.sr-only` 全部零命中，只有 `@font-face` 与 `:root` 变量）。
 *
 * 后果不是「构建失败」，而是**构建成功、页面能开、全部无样式**：
 * - 布局全部塌成文档流（`min-h-svh`、`flex`、`grid` 失效）
 * - 移动端出现 619px 横向溢出（`overflow-hidden` 与 `w-[190px]` 没生效，
 *   CentralPlanet 那个比球体大 72% 的 canvas 直接撑破视口）
 * - P7 的 54 条 HTTP 验收全绿 —— 因为它只查状态码、响应头、HTML 字节数，
 *   从来不查 CSS 是否完整
 *
 * ── 为什么用 `@tailwindcss/postcss` 而不是复制一份规则 ────────────────
 * 两条路径必须产出**同一份** CSS。把 Tailwind 的接入方式写两遍（Turbopack 一套、
 * Webpack 一套）本身就是漂移源：改了 `globals.css` 的 `@theme` 之后，只有
 * 一条路径会跟着变。用官方 PostCSS 插件 + 同一份 `globals.css`，
 * 至少保证「输入相同」。
 *
 * ── 为什么不删掉 turbopack.rules 只留 PostCSS ─────────────────────────
 * dev 走 Turbopack，删掉 rules 会让 dev 也依赖 PostCSS —— 而 dev 的 CSS 热更新
 * 在 Turbopack 原生 loader 下更快、错误信息更准。两条路径各用各的原生接入，
 * 是这个项目已经验证过的组合（dev 的 CSS 一直是完整的）。
 *
 * ── 自检 ─────────────────────────────────────────────────────────────
 * 光有这个文件还不够 —— 它只是「应该能工作」。真正的保险是
 * `scripts/check-css-completeness.mjs`：构建后扫 CSS 产物，缺关键工具类就退出码 1。
 * 没有那个自检，这个文件被谁删掉也不会有人发现。
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
