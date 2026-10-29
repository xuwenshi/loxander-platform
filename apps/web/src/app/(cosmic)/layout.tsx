import type { Viewport } from "next";
import type { ReactNode } from "react";

import CosmicChrome from "@/components/cosmic/CosmicChrome";

/**
 * 宇宙层外壳：/（星海入口）与 /universe（行星星图）。
 *
 * 关键点：`.cosmic-scope` 直接出现在服务端输出的 HTML 里，因此
 * 底色与滚动区域底色在首屏就已经正确，不会出现「先白后黑」的闪屏。
 */

/* 换皮后宇宙层也跟随主题：深色是夜空 #05070a，浅色是暖白纸 #f6f2e9。
   这里声明深色默认值（与 layout.tsx 的 THEME_COLORS.dark 一致），
   浅色用户由 ThemeToggle 在客户端修正。 */
export const viewport: Viewport = {
  themeColor: "#05070a",
};

export default function CosmicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="cosmic-scope flex flex-1 flex-col">
      <span aria-hidden className="cosmic-backdrop" />
      <CosmicChrome />

      <main id="main" className="relative z-10 flex flex-1 flex-col">
        {children}
      </main>
    </div>
  );
}