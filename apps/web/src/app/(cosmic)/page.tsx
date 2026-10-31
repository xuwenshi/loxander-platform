import type { Metadata } from "next";

import CosmicLink from "@/components/cosmic/CosmicLink";
import HomeHero from "@/components/site/HomeHero";
import { ArrowRightIcon } from "@/components/ui/Icons";
import { cosmicQuickNav, heroAccent, cosmicSections } from "@/lib/cosmic";
import { siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  description: `进入 ${siteConfig.author} 的个人宇宙：简历、项目、文章、日记、目标五大行星分区，以及持续更新的技术记录。`,
};

/** 首屏下方的「快速导航」：把 7 个目的地以真实链接列出 */
const quickNav = [
  { href: "/universe", label: "星图", latin: "STAR MAP", accent: heroAccent },
  ...cosmicQuickNav.map((item) => ({
    href: item.href,
    label: item.label,
    latin: item.latin,
    accent:
      cosmicSections.find((section) => section.href === item.href)?.accent ?? "#e8ecf6",
  })),
];

/**
 * 星海入口（/）。
 *
 * 首屏 100svh：深空底 + 多层粒子 Canvas + 中央自转主星球（真实 <Link> 入口）。
 *
 * 换皮后的构图变化：
 * - 左侧一条竖排的「观测站编号」，把页面从「居中一球一行字」的纪念碑
 *   变成有边缘的观测窗；
 * - 标题用衬线体压到最大，副行是 tagline，构成真正的版式层级；
 * - 底部加一条四格状态栏，让首屏就有信息密度，而不是大片空白。
 *
 * 首屏下方的「快速导航」区块保持不变（SEO 内链 / 无 JS 兜底 / 降低跳出）。
 */
export default function CosmicHomePage() {
  return (
    <>
      <HomeHero />

      <section className="relative z-10 border-t border-cosmic-line">
        <div className="mx-auto w-full max-w-5xl px-5 py-14 sm:px-10">
          <h2 className="font-serif text-lg font-medium tracking-tight text-cosmic-text sm:text-xl">
            快速导航
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-cosmic-muted">
            不想在星海里找也行 —— 下面是全部入口，直接点击即可进入。
          </p>

          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {quickNav.map((item) => (
              <li key={item.href}>
                <CosmicLink
                  href={item.href}
                  variant="warp"
                  className="group flex h-full items-center justify-between gap-3 rounded-xl border border-cosmic-line bg-surface px-4 py-3.5 transition-colors hover:border-accent/60 hover:bg-elevated"
                >
                  <span className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: item.accent }}
                    />
                    <span>
                      <span className="block text-sm font-medium text-cosmic-text">
                        {item.label}
                      </span>
                      <span className="block text-xs font-medium uppercase tracking-[0.18em] text-cosmic-muted">
                        {item.latin}
                      </span>
                    </span>
                  </span>

                  <ArrowRightIcon
                    width={16}
                    height={16}
                    className="shrink-0 text-cosmic-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
                  />
                </CosmicLink>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
