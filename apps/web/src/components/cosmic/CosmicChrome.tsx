import CosmicLink from "@/components/cosmic/CosmicLink";
import ThemeToggle from "@/components/layout/ThemeToggle";

import { siteConfig } from "@/lib/site";

/**
 * 宇宙层的极简外壳（服务端组件）。
 *
 * 刻意保持克制：品牌 + 「入口 / 星图」两个真实链接 + 主题控件。
 * 悬停在 fixed 头部之上，让星海/星图保持整屏观感；容器不拦截鼠标事件，
 * 只有链接与控件本身可点（pointer-events-auto），所以不会挡住下方的星球交互。
 *
 * 两个链接都走 CosmicLink（warp 变体）—— 宇宙层内部的移动本身
 * 就是一次「星球穿越」，不应该是没有转场的硬跳。
 *
 * 换皮要点：
 * - 顶部不再是 `from-cosmic-void/85` 的硬渐变（浅色下会糊成一条灰带），
 *   改成与站点导轨同一套 `--scrim-rgb` 渐隐 + 背景模糊；
 * - 补上 ThemeToggle —— 否则用户在首页/星图页无法切换深浅色，
 *   必须先点进行星内部才能找到开关，这是明显的体验缺口。
 */
export default function CosmicChrome() {
  const navLinkClass =
    "inline-flex min-h-11 items-center px-3 font-mono text-[0.625rem] uppercase tracking-[0.2em] text-cosmic-muted transition-colors hover:text-cosmic-text";

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-40">
      {/* 背景层单独画，避免背景样式作用到子元素。
          这里刻意不做 backdrop-filter：宇宙层背后是两层持续动画的画布，
          模糊会变成逐帧重算的全宽开销（与站点导轨同一处理，见 globals.css
          里 .site-rail 的注释）。原型也只有这条渐隐渐变。 */}
      <span
        aria-hidden
        className="absolute inset-0 -z-10 border-b border-border"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, rgba(var(--scrim-rgb),0.92) 0%, rgba(var(--scrim-rgb),0.62) 62%, transparent 100%)",
        }}
      />

      {/* paddingTop 用 safe-area-inset：横屏时避开刘海 / 挖孔 */}
      <div
        className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-5 pb-3 sm:px-8"
        style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top, 0px))" }}
      >
        <CosmicLink
          href="/"
          variant="warp"
          className="pointer-events-auto inline-flex min-h-11 items-baseline gap-2 text-foreground transition-opacity hover:opacity-80"
        >
          <b className="font-serif text-[0.9375rem] font-medium tracking-[0.06em]">
            {siteConfig.name}
          </b>
          <span className="font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted">
            / Observatory
          </span>
        </CosmicLink>

        <div className="pointer-events-auto flex items-center gap-2">
          <nav aria-label="宇宙导航" className="flex items-center gap-1">
            <CosmicLink href="/" variant="warp" className={navLinkClass}>
              入口
            </CosmicLink>
            <CosmicLink href="/universe" variant="warp" className={navLinkClass}>
              星图
            </CosmicLink>
          </nav>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
