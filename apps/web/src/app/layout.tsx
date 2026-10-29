import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";

import CosmicTransitionProvider from "@/components/cosmic/TransitionProvider";
import CosmicTransitionOverlay from "@/components/cosmic/TransitionOverlay";
import Ambience from "@/components/layout/Ambience";
import ParticleWave from "@/components/layout/ParticleWave";
import { siteConfig } from "@/lib/site";

import "./globals.css";

/*
 * 换皮后不再加载 Geist：观测站的排版身份是
 * 「衬线标题 + 无衬线正文 + 等宽数据」的中文系统字体栈，
 * 全部由 globals.css 的 --font-stack-* 提供，零网络字节。
 * 中文字形本来就不在 Geist 的 latin 子集里，之前全站中文一直是
 * 落到系统兜底字体上，这里只是把既成事实写成声明。
 */

const defaultTitle = `${siteConfig.author} · ${siteConfig.role}`;

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: defaultTitle,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  keywords: [
    "机器学习",
    "数据科学",
    "数据挖掘",
    "RAG",
    "LLM",
    "Agent",
    "Next.js",
    siteConfig.author,
  ],
  authors: [{ name: siteConfig.author, url: siteConfig.url }],
  creator: siteConfig.author,
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: siteConfig.url,
    siteName: siteConfig.name,
    title: defaultTitle,
    description: siteConfig.description,
  },
  twitter: {
    card: "summary_large_image",
    title: defaultTitle,
    description: siteConfig.description,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

/**
 * 浏览器界面（移动端地址栏 / 状态栏）配色。
 * 必须与 globals.css 里 --background 的实际取值一致，否则会出现
 * 「深空页面顶着一条白色状态栏」。主题由 class 决定，媒体查询猜不准，
 * 所以浅色用户由 ThemeToggle 在拿到真实主题后修正这个 meta。
 *
 * 换皮后：深空 #05070a（观测站夜空）、浅色 #f6f2e9（暖白星图册纸色）。
 */
const THEME_COLORS = { dark: "#05070a", light: "#f6f2e9" } as const;

export const viewport: Viewport = {
  // width=device-width 之外还要显式声明 viewportFit: cover，
  // 否则 iOS 上的 env(safe-area-inset-*) 恒为 0，刘海 / 底部指示条会压住内容。
  viewportFit: "cover",
  // 只声明一个「默认值」：本站默认深色（见 themeInitScript），所以这里是深空底色。
  //
  // 为什么不用 media 版本（light/dark 各一条）：
  // 本站主题由 <html> 上的 class 决定，而不是 prefers-color-scheme，
  // 「系统浅色 + 站点选了深色」的用户会命中浅色那条，出现
  // 「深空页面顶着一条白色状态栏」。
  //
  // 为什么不在内联脚本里改 meta：
  // 实测发现框架托管的 viewport meta 会在 hydration 之后被重新插入，
  // 脚本即使删掉它也会被加回来，结果页面里同时存在两条 theme-color，
  // 谁生效取决于插入顺序 —— 不可控。
  //
  // 因此策略是：静态声明默认值（首屏即为正确值，不闪），
  // 真实主题与它不一致时（用户选了浅色）由 ThemeToggle 在客户端修正。
  themeColor: THEME_COLORS.dark,
};

/**
 * 在 hydration 之前就把主题写到 <html> 上，避免暗色模式用户看到白色闪屏。
 * 这段脚本只读取 localStorage，不涉及任何用户输入。
 *
 * 默认值是 "dark"（而不是 "system"）：本站的视觉母题是深空，
 * 首次访问就应该进入宇宙，而不是取决于用户操作系统的明暗设置。
 * 想跟随系统的用户点一次主题按钮即可，三态循环与 ThemeToggle 保持一致。
 *
 * 这里不碰 meta[name="theme-color"]：框架托管的 viewport meta 会在
 * hydration 之后被重新插入，脚本删了也会被加回来（见 viewport 注释）。
 * 该 meta 由 viewport 静态声明默认值，浅色用户由 ThemeToggle 修正。
 *
 * 注意：宇宙层（/ 与 /universe）现在也跟随主题 —— 换皮后 `.cosmic-scope`
 * 的底色是 `var(--background)`，深色是夜空、浅色是暖白纸，两者都有星图。
 */
const themeInitScript = `(function(){try{var t=localStorage.getItem("theme")||"dark";var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";var a=localStorage.getItem("accent");if(a&&a!=="copper")r.setAttribute("data-accent",a);}catch(e){}})();`;

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Person",
      "@id": `${siteConfig.url}/#person`,
      name: siteConfig.author,
      jobTitle: siteConfig.role,
      description: siteConfig.description,
      url: siteConfig.url,
      email: `mailto:${siteConfig.email}`,
      sameAs: [siteConfig.github],
      knowsAbout: siteConfig.focus,
    },
    {
      "@type": "WebSite",
      "@id": `${siteConfig.url}/#website`,
      name: siteConfig.name,
      url: siteConfig.url,
      description: siteConfig.description,
      inLanguage: "zh-CN",
      publisher: { "@id": `${siteConfig.url}/#person` },
    },
  ],
};

/**
 * 根外壳（极简）。
 *
 * 这里刻意不再渲染 Navbar / Footer —— 它们属于「行星内部」的站点外壳，
 * 已经下沉到 (site)/layout.tsx；宇宙层则由 (cosmic)/layout.tsx 提供深空外壳。
 * 根布局只负责：html/body、主题脚本、跳转链接、结构化数据。
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className="h-full antialiased">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-background"
        >
          跳到主要内容
        </a>

        <CosmicTransitionProvider>
          {/* 氛围层（暗角 / 颗粒 / 指针跟随 / 粒子浪潮）挂在根外壳上：
              宇宙层、行星内部、admin 共用同一张纸，才算「整站换皮」。
              全部是 pointer-events:none 的纯装饰，不参与任何布局与交互。 */}
          <Ambience />
          <ParticleWave />
          {children}
          <CosmicTransitionOverlay />
        </CosmicTransitionProvider>

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />

        {/*
          Vercel Web Analytics（方案 §15.1「必须监控」的运行时侧）。
          它只在 Vercel 平台上真正上报：本地 `next start` 时脚本会被注入但
          没有 /_vercel/insights 端点，请求静默失败，不影响任何页面行为。
          刻意不传任何参数 —— `mode`/`debug` 只在排查时用，生产默认值就是对的。
        */}
        <Analytics />
      </body>
    </html>
  );
}