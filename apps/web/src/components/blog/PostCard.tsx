import CosmicLink from "@/components/cosmic/CosmicLink";
import { Chip } from "@/components/ui/Badge";
import { ArrowRightIcon, CalendarIcon, ClockIcon, FolderIcon } from "@/components/ui/Icons";
import { formatDate } from "@/lib/format";
import type { PostMeta } from "@/types";

/**
 * 文章卡片：列表页与首页共用。
 *
 * 换皮要点（对齐观测站语言，不改数据与链接）：
 * - 元信息（日期 / 分类 / 时长）统一成等宽小字 + 大字距，像仪器读数；
 * - 标题换衬线，与正文形成「标题是有语气的声音、正文是信息」的层次；
 * - 卡片不再只是描边矩形：hover 时左侧长出一条铜色细线，
 *   与原型里项目列表的行前导线是同一套动作。
 */
export default function PostCard({ post }: { post: PostMeta }) {
  const metaClass =
    "inline-flex items-center gap-1.5 font-mono text-[0.625rem] uppercase tracking-[0.14em]";

  return (
    <article className="group relative flex flex-col rounded-xl border border-border bg-elevated p-5 transition-colors hover:border-accent/50">
      {/* hover 时从左侧长出的铜色细线：与原型项目列表的行前导线同源 */}
      <span
        aria-hidden
        className="absolute inset-y-4 left-0 w-px origin-top scale-y-0 bg-accent transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-y-100"
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
        <span className={metaClass}>
          <CalendarIcon width={12} height={12} />
          <time dateTime={post.date}>{formatDate(post.date)}</time>
        </span>
        <span className={metaClass}>
          <FolderIcon width={12} height={12} />
          {post.category}
        </span>
        <span className={metaClass}>
          <ClockIcon width={12} height={12} />
          {post.readingTime} min
        </span>
      </div>

      <h3 className="mt-3 font-serif text-lg font-medium leading-snug tracking-tight text-foreground sm:text-xl">
        <CosmicLink href={`/blog/${post.slug}`} className="after:absolute after:inset-0">
          {post.title}
        </CosmicLink>
      </h3>

      <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted">
        {post.description}
      </p>

      <div className="mt-4 flex items-end justify-between gap-3">
        <ul className="flex flex-wrap gap-1.5">
          {post.tags.slice(0, 4).map((tag) => (
            <li key={tag}>
              <Chip>{tag}</Chip>
            </li>
          ))}
        </ul>

        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-accent">
          阅读
          <ArrowRightIcon
            width={14}
            height={14}
            className="transition-transform group-hover:translate-x-0.5"
          />
        </span>
      </div>
    </article>
  );
}
