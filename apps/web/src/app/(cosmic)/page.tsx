import type { Metadata } from "next";

import CentralPlanet from "@/components/cosmic/CentralPlanet";
import CosmicLink from "@/components/cosmic/CosmicLink";
import Starfield from "@/components/cosmic/Starfield";
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

/** 首屏左下角的状态栏：观测站的身份铭牌，不是装饰 */
const STATUS: { k: string; v: string }[] = [
  { k: "观测位置", v: siteConfig.location },
  { k: "当前方向", v: "检索与 LLM 工程" },
  { k: "在写", v: "技术文章 · 项目复盘" },
  { k: "状态", v: "开放交流" },
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
      <section className="cosmic-enter relative flex min-h-svh flex-col justify-center overflow-hidden px-5 py-24 sm:px-10">
        <Starfield />

        {/* 左侧竖排编号：给首屏一条"边缘"，打破居中纪念碑感 */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-5 top-1/2 hidden -translate-y-1/2 font-mono text-[0.625rem] tracking-[0.42em] text-cosmic-muted [writing-mode:vertical-rl] lg:block"
        >
          OBSERVATORY · SINCE 2024 · CN
        </span>

        <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col">
          <p className="font-mono text-[0.6875rem] tracking-[0.32em] text-cosmic-muted">
            {siteConfig.author} · {siteConfig.role}
          </p>

          {/* 首屏唯一的一级标题：本站是「作者的个人宇宙」，作者名与身份就是页面主题。
              之前这里是一个 <p>，导致 / 整页没有 h1，标题大纲从二级开始。 */}
          <h1 className="mt-5 max-w-3xl font-serif text-[clamp(2.25rem,5.4vw,4.5rem)] font-medium leading-[1.16] tracking-tight text-cosmic-text">
            在深空里，
            <br />
            构建<em className="not-italic text-accent">可解释</em>的系统。
          </h1>

          <p className="mt-6 max-w-xl text-base leading-relaxed text-cosmic-muted">
            {siteConfig.tagline}
            这里是我的观测记录：机器学习建模、农业数据挖掘、RAG
            与 LLM 工程实践中的问题、原理、实验与踩坑。
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <CosmicLink
              href="/universe"
              variant="warp"
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover"
            >
              打开星图
              <ArrowRightIcon width={15} height={15} />
            </CosmicLink>
            <CosmicLink
              href="/blog"
              variant="soft"
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-accent/60"
            >
              直接读文章
            </CosmicLink>
          </div>

          <div className="mt-14">
            <CentralPlanet />
          </div>

          {/* 四格状态栏：首屏的信息密度来自这里 */}
          <dl className="mt-14 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-cosmic-line pt-6 sm:grid-cols-4">
            {STATUS.map((item) => (
              <div key={item.k}>
                <dt className="font-mono text-[0.5625rem] tracking-[0.2em] text-cosmic-muted">
                  {item.k}
                </dt>
                <dd className="mt-1.5 text-sm text-cosmic-text">{item.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

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
