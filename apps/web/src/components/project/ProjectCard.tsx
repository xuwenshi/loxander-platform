import CosmicLink from "@/components/cosmic/CosmicLink";
import { Chip, StatusBadge } from "@/components/ui/Badge";
import { ArrowRightIcon, ExternalLinkIcon, GithubIcon } from "@/components/ui/Icons";
import type { ProjectMeta } from "@/types";

/**
 * 项目卡片。
 *
 * 封面不用真实图片：由「主题表面 + 主强调色柔光 + 项目首字母」构成。
 *
 * 换皮时改掉了原来的做法：早先封面写死 `--cosmic-deep / --cosmic-void`
 * 两块恒定深空色，浅色主题下会变成「一张深色块贴在暖白纸上」。
 * 现在封面完全走主题令牌（--surface / --elevated / --accent），
 * 明暗两种模式下都是同一套语言，只是明暗互换。
 */
export default function ProjectCard({ project }: { project: ProjectMeta }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-elevated transition-colors hover:border-accent/50">
      <div className="relative flex h-28 items-center justify-between overflow-hidden border-b border-border bg-surface px-5">
        {/* 主强调色的柔光，给封面一点层次，不改变整体一致性 */}
        <span
          aria-hidden
          className="absolute inset-0 opacity-[0.22]"
          style={{
            backgroundImage:
              "radial-gradient(120% 130% at 16% 0%, var(--accent), transparent 58%)",
          }}
        />
        {/* 细网格：像观测记录纸上的坐标格 */}
        <span
          aria-hidden
          className="absolute inset-0 opacity-[0.5]"
          style={{
            backgroundImage:
              "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />

        <span
          aria-hidden
          className="relative font-serif text-4xl font-medium text-foreground"
        >
          {project.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="relative rounded-xs border border-border bg-elevated px-2.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
          {project.period ?? "项目"}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={project.status} />
          {project.role ? <Chip>{project.role}</Chip> : null}
        </div>

        <h3 className="mt-3 font-serif text-lg font-medium leading-snug tracking-tight text-foreground sm:text-xl">
          <CosmicLink
            href={`/projects/${project.slug}`}
            className="after:absolute after:inset-0"
          >
            {project.name}
          </CosmicLink>
        </h3>

        <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">
          {project.description}
        </p>

        <ul className="mt-4 flex flex-wrap gap-1.5">
          {project.techStack.slice(0, 5).map((tech) => (
            <li key={tech}>
              <Chip>{tech}</Chip>
            </li>
          ))}
        </ul>
      </div>

      {/* 卡片外的独立链接：用 relative 容器避免被整卡链接覆盖 */}
      <div className="relative z-10 flex flex-wrap items-center gap-4 border-t border-border px-5 py-3 text-sm">
        <CosmicLink
          href={`/projects/${project.slug}`}
          className="inline-flex items-center gap-1 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-accent transition-colors hover:text-accent-hover"
        >
          查看详情
          <ArrowRightIcon
            width={14}
            height={14}
            className="transition-transform group-hover:translate-x-0.5"
          />
        </CosmicLink>

        {project.github ? (
          <a
            href={project.github}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-muted transition-colors hover:text-foreground"
          >
            <GithubIcon width={15} height={15} />
            GitHub
          </a>
        ) : null}

        {project.demo ? (
          <a
            href={project.demo}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-muted transition-colors hover:text-foreground"
          >
            <ExternalLinkIcon width={15} height={15} />
            Demo
          </a>
        ) : null}
      </div>
    </article>
  );
}
