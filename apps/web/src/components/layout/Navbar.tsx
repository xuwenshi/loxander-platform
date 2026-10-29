import CosmicLink from "@/components/cosmic/CosmicLink";

import Navigation from "./Navigation";
import ThemeToggle from "./ThemeToggle";
import { navWithGithub, siteConfig } from "@/lib/site";

/**
 * 全站导航栏 —— 换皮后是「观测站导轨」。
 *
 * 一条贴着顶边的 1px 轨道贯穿全宽：左边是站名，右边是色板与三态明暗，
 * 中间是九个分区节点（`.site-node`）。当前页面的滚动进度由轨道填充
 * 与游标光点表示，因此这个外壳本身不需要任何交互逻辑，仍是服务端组件。
 *
 * 只有 Navigation / ThemeToggle 是客户端组件。
 */
export default function Navbar() {
  return (
    <header className="site-rail">
      {/* paddingTop 用 safe-area-inset：横屏时避开刘海 / 挖孔；
          竖屏与桌面端该值为 0，--rail 保证高度不变 */}
      <div
        className="site-rail__inner"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <CosmicLink href="/" className="site-rail__brand">
          <b>{siteConfig.name}</b>
          <span className="hidden sm:inline">/ OBSERVATORY</span>
        </CosmicLink>

        <Navigation links={navWithGithub} />

        <div className="site-rail__ctrl">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
