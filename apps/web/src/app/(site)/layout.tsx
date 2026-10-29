import type { ReactNode } from "react";

import Footer from "@/components/layout/Footer";
import Navbar from "@/components/layout/Navbar";

/**
 * 「行星内部」的外壳：站点导轨 + 内容 + 页脚。
 *
 * 路由组 (site) 不改变 URL —— /blog、/projects、/about、/resume、/diary、/goals
 * 仍然是原来的地址，只是共用这一层。
 *
 * 换皮后导轨是 fixed（不再 sticky），所以 main 要用 `.rail-offset`
 * 让出顶部高度，否则第一行内容会被导轨压住。
 *
 * `relative z-10` 是氛围层带来的硬需求：暗角（`.cosmic-vignette` z-1）与
 * 颗粒（`.cosmic-grain` z-2）都是 position:fixed，而 main 里的内容本身没有定位，
 * 会落在它们下面 —— 深色主题的 `--vig-2` 是 88% 的近黑蒙层，等于把整页文字边缘
 * 压黑。原型里各内容分区是 z-index:10（redesign.html:595/939），暗角只压背景，
 * 这里照抄同一个层级关系。导轨是 fixed z-40，粒子浪潮是 z-12，所以 10 既高于
 * 暗角、又低于浪潮与导轨，次序与原型一致。
 */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Navbar />
      <main id="main" className="rail-offset relative z-10 flex-1">
        {children}
      </main>
      <Footer />
    </>
  );
}
