import type { ReactNode } from "react";

import CosmicLink from "@/components/cosmic/CosmicLink";
import { ArrowLeftIcon } from "@/components/ui/Icons";
import type { CosmicSection } from "@/lib/cosmic";

/**
 * 分区页统一的页头（服务端组件）。
 *
 * 五大分区行星与「关于」页共用它，叠加统一的宇宙设计语言：
 * ①「← 返回星图」让用户随时回到五大行星；
 * ② 分区识别色的 eyebrow（文字仍走主题色 text-accent 以保证对比度，
 *   只在旁边放一个极小的识别色圆点，颜色不承担阅读职责）；
 * ③ 入场动效（cosmic-enter），reduced-motion 下由全局兜底自动关闭。
 *
 * 换皮后：标题改为衬线体并放大，eyebrow 改为等宽字母间距 ——
 * 这是全站最容易辨认「观测站」身份的一处版式信号。
 */
export default function SectionIntro({
  section,
  title,
  description,
  children,
}: {
  section: Pick<CosmicSection, "latin" | "accent">;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="cosmic-enter border-b border-border pb-8">
      <CosmicLink
        href="/universe"
        variant="warp"
        className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeftIcon width={15} height={15} />
        返回星图
      </CosmicLink>

      <p className="mt-4 inline-flex items-center gap-2 font-mono text-[0.6875rem] uppercase tracking-[0.22em] text-accent">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: section.accent }}
        />
        {section.latin}
      </p>

      <h1 className="mt-3 font-serif text-[clamp(1.875rem,4vw,2.75rem)] font-medium leading-[1.2] tracking-tight text-foreground">
        {title}
      </h1>

      {description ? (
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
          {description}
        </p>
      ) : null}

      {children ? <div className="mt-5">{children}</div> : null}
    </header>
  );
}
