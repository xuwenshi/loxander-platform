import CosmicLink from "@/components/cosmic/CosmicLink";
import { GithubIcon, MailIcon } from "@/components/ui/Icons";
import { siteConfig } from "@/lib/site";

/**
 * 页脚（服务端组件）。
 *
 * 换皮后从「一行链接」改成观测站的「四栏铭牌」：
 * 观测站身份 / 分区地图 / 建造方式 / 联络方式。
 * 这是原型里 footer 的结构，也是让长页面有一个自然的落点。
 *
 * 版权年份需要读取「当前时间」。在 Cache Components 模式下，这类不稳定值
 * 不能直接出现在预渲染路径上，因此用 `use cache` 把它标记为可缓存：
 * 构建时算一次，之后每次部署自动更新。
 */
export default async function Footer() {
  "use cache";

  const year = new Date().getFullYear();

  const colTitle = "font-mono text-[0.5625rem] uppercase tracking-[0.24em] text-muted";
  const colLink =
    "inline-flex min-h-11 items-center text-sm text-muted transition-colors hover:text-foreground";

  return (
    /* relative z-10：页脚是 <main> 的兄弟节点，同样会落在氛围层的暗角（z-1）
       与颗粒（z-2）之下。深色主题的 --vig-2 是 88% 近黑，不抬起来页脚文字会发黑。 */
    <footer className="relative z-10 mt-16 border-t border-border">
      {/* 页面最底部要避开 iOS 的 Home 指示条（viewportFit: cover 之后 inset 才非 0） */}
      <div className="mx-auto w-full max-w-5xl px-4 pt-12 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {/* ① 观测站身份 */}
          <div>
            <p className={colTitle}>Observatory</p>
            <p className="mt-3 font-serif text-lg font-medium text-foreground">
              {siteConfig.name}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {siteConfig.tagline}
            </p>
          </div>

          {/* ② 分区地图 */}
          <nav aria-label="页脚导航">
            <p className={colTitle}>Sections</p>
            {/* min-h-11(44px) + inline-flex：文字链接的视觉尺寸不变，
                但触控命中区域达到 44×44 的最小推荐值（WCAG 2.5.5） */}
            <ul className="mt-2 flex flex-col">
              {siteConfig.navLinks.map((link) => (
                <li key={link.href}>
                  <CosmicLink href={link.href} className={colLink}>
                    {link.label}
                  </CosmicLink>
                </li>
              ))}
            </ul>
          </nav>

          {/* ③ 建造方式 */}
          <div>
            <p className={colTitle}>Built with</p>
            <ul className="mt-3 space-y-1.5 text-sm text-muted">
              <li>Next.js 16 · App Router</li>
              <li>React 19 · TypeScript</li>
              <li>Tailwind CSS v4</li>
              <li>Markdown → Shiki</li>
            </ul>
          </div>

          {/* ④ 联络方式 */}
          <div>
            <p className={colTitle}>Contact</p>
            <ul className="mt-2 flex flex-col">
              <li>
                <a
                  href={siteConfig.github}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={`${colLink} gap-2`}
                >
                  <GithubIcon width={15} height={15} />
                  GitHub
                </a>
              </li>
              <li>
                <a href={`mailto:${siteConfig.email}`} className={`${colLink} gap-2`}>
                  <MailIcon width={15} height={15} />
                  {siteConfig.email}
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted">
            © {year} {siteConfig.author}. 使用 Next.js 构建。
          </p>
          <p className="font-mono text-[0.5625rem] uppercase tracking-[0.24em] text-muted">
            Observatory · {siteConfig.location}
          </p>
        </div>
      </div>
    </footer>
  );
}
