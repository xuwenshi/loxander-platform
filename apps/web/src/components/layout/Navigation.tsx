"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import CosmicLink from "@/components/cosmic/CosmicLink";
import { CloseIcon, MenuIcon } from "@/components/ui/Icons";
import type { NavLink } from "@/lib/site";

/**
 * 导航链接（客户端组件）。
 *
 * 换皮后它承担两件事：
 * 1. 把「顶部导轨」渲染出来 —— 一条 1px 轨道 + 进度填充 + 一个游标光点，
 *    每个分区是一个 `.site-node`（6px 圆点，hover 出标签）。
 * 2. 依旧负责当前路由高亮与移动端菜单开合，因此仍是客户端组件，
 *    外壳（Navbar）保持服务端渲染。
 *
 * 为什么节点位置用百分比均分而不是测量出来的偏移：
 * 真站是多页面路由，不像原型那样有一条长滚动条可以量出每个分区的
 * 起始位置；九个入口在轨道上等距分布就是它们「地图坐标」最诚实的表达。
 * 轨道填充与游标则跟随当前页面的滚动进度。
 *
 * 站内链接统一走 CosmicLink（soft 变体），点击时播一次同体系短转场；
 * 外链、GitHub 等仍用原生 <a>，不参与转场。
 */
export default function Navigation({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const headRef = useRef<HTMLSpanElement | null>(null);
  const pctRef = useRef<HTMLSpanElement | null>(null);

  /* 路由变化（含浏览器前进/后退）后收起菜单。
     这是 React 官方推荐的「props 变化时调整 state」写法：在渲染期比较并重置，
     而不是放进 useEffect（effect 里同步 setState 会引发额外的级联渲染）。 */
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  /* 菜单展开时按 Esc 关闭，并把焦点还给开合按钮（键盘用户的常规预期） */
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      document
        .querySelector<HTMLButtonElement>('[aria-controls="mobile-nav"]')
        ?.focus();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  /**
   * 导轨进度：滚动百分比 → 填充宽度、游标位置、右下角三位读数。
   * 只写 style / textContent，不触发 React 重渲染。
   * `passive: true` 保证不会阻塞滚动；rAF 去重避免一次滚动多次布局读取。
   */
  useEffect(() => {
    const fill = fillRef.current;
    const head = headRef.current;
    const pct = pctRef.current;
    if (!fill || !head) return;

    let frame = 0;

    const paint = () => {
      frame = 0;
      const doc = document.documentElement;
      const total = doc.scrollHeight - window.innerHeight;
      const ratio = total > 0 ? Math.min(Math.max(window.scrollY / total, 0), 1) : 0;
      const percent = `${(ratio * 100).toFixed(3)}%`;
      fill.style.width = percent;
      head.style.left = percent;
      if (pct) {
        pct.textContent = String(Math.round(ratio * 100)).padStart(3, "0");
      }
    };

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(paint);
    };

    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  /** 轨道上只挂站内分区；外链（GitHub 等）留在移动面板里 */
  const railLinks = useMemo(
    () => [{ href: "/", label: "主页" }, ...links.filter((link) => !link.external)],
    [links],
  );

  const desktopLinkClass = (href: string) =>
    [
      // min-h-11：文字链接的触控命中区域达到 44px 高（WCAG 2.5.5）
      "inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium transition-colors",
      isActive(href)
        ? "text-foreground"
        : "text-muted hover:text-foreground hover:bg-surface",
    ].join(" ");

  const mobileLinkClass = (href: string) =>
    [
      "flex min-h-11 items-center rounded-md px-3 py-2.5 text-base font-medium transition-colors",
      isActive(href)
        ? "bg-surface text-foreground"
        : "text-muted hover:bg-surface hover:text-foreground",
    ].join(" ");

  return (
    <>
      {/* 顶部导轨：一条 1px 轨道，九个节点，进度填充 + 游标 */}
      <div className="site-rail__track" ref={trackRef}>
        <span className="site-rail__fill" ref={fillRef} />
        <span className="site-rail__head" ref={headRef} />
        {railLinks.map((link, index) => (
          <CosmicLink
            key={link.href}
            href={link.href}
            className="site-node min-h-11"
            style={{
              left: `${((index + 0.5) / railLinks.length) * 100}%`,
            }}
            title={link.label}
            aria-label={link.label}
            aria-current={isActive(link.href) ? "page" : undefined}
          >
            <b aria-hidden />
            <span>{link.label}</span>
          </CosmicLink>
        ))}
      </div>

      <span className="rail-pct" aria-hidden ref={pctRef}>
        000
      </span>

      {/* 移动端菜单按钮 */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? "关闭菜单" : "打开菜单"}
        className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-surface hover:text-foreground md:hidden"
      >
        {open ? <CloseIcon width={18} height={18} /> : <MenuIcon width={18} height={18} />}
      </button>

      {/* 移动端展开面板：九个入口带完整中文标签，导轨上的小圆点只是地图 */}
      {open ? (
        <nav
          id="mobile-nav"
          aria-label="移动端导航"
          className="absolute inset-x-0 top-full border-b border-border bg-background p-3 md:hidden"
          style={{ boxShadow: "var(--shadow-deep)" }}
        >
          <ul className="flex flex-col gap-1">
            {links.map((link) => (
              <li key={link.href}>
                {link.external ? (
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={mobileLinkClass(link.href)}
                  >
                    {link.label}
                  </a>
                ) : (
                  <CosmicLink
                    href={link.href}
                    className={mobileLinkClass(link.href)}
                    // 点击后立即收起菜单，比监听路由变化再同步状态更直接
                    onClick={() => setOpen(false)}
                  >
                    {link.label}
                  </CosmicLink>
                )}
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </>
  );
}
