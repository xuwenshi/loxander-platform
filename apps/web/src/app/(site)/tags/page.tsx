import type { Metadata } from "next";

import Link from "next/link";

import SectionIntro from "@/components/cosmic/SectionIntro";
import { EmptyState } from "@/components/ui/SectionHeading";
import { getSection } from "@/lib/cosmic";
import { getAllPosts, getAllTags } from "@/lib/content";
import { mergeTagsByUrl, SEARCH_PATH, tagHref } from "@/lib/tag-url";

/**
 * 标签总览页 `/tags`（P5 新增）。
 *
 * ── 为什么要有这一页 ────────────────────────────────────────────────
 * P4 之前 `TagLink` 的 href 硬编码 `/blog`：点标签只是回文章列表，
 * 等于「标签是纯装饰」。方案 §11 P5 要求「标签页 + 标签页 URL 稳定」，
 * 所以补两条路由：本页（全部标签）与 `/tags/[tag]`（单个标签）。
 *
 * ── URL 稳定性怎么保证 ──────────────────────────────────────────────
 * 统一的归一化规则放在 `lib/tag-url.ts`：**URL 一律小写**。
 * `getAllTags()` 按原字符串计数，所以理论上库里可能同时有 `"RAG"` 与 `"rag"`
 * 两个标签（`db/mapping.ts` 的 `tagSlugOf` 是恒等函数，不做 slugify）。
 * 若直接渲染，这一页会产出两个 `href` 完全相同的链接、`sitemap.xml` 出现两条相同 URL ——
 * 正是验收第 3 条要扣分的形态。
 *
 * 所以这里先过一道 `mergeTagsByUrl()`：按归一化后的 URL 片段合并、计数相加、
 * 展示名取先出现的原字符串。`/tags/rag` 页面列出的文章数（`getPostsByTag` 大小写不敏感）
 * 与合并后的计数天然一致。
 *
 * 当前真实数据 14 个标签无仅大小写不同的重复，但这是「作者随时可能写出来」的形态。
 *
 * ── 为什么这一页用 ISR ──────────────────────────────────────────────
 * 方案 §14.2 把「公开列表页」定为 ISR 按类型标签缓存。本页的数据
 * 全部来自 `getAllPosts()` / `getAllTags()`，与 `/blog` 列表页同一份，
 * 所以不需要自己声明缓存 —— `sources/db.ts` 的 `getAllPostsCached()`
 * 已经打了 `entries:blog` + `entries:all`，发布/归档时会被 `updateTag` 失效。
 */

export const metadata: Metadata = {
  title: "标签",
  description: "按标签浏览全部文章：机器学习、数据挖掘、RAG、工程实践等主题。",
  alternates: { canonical: "/tags" },
};

export default async function TagsPage() {
  const [rawTags, posts] = await Promise.all([getAllTags(), getAllPosts()]);
  const tags = mergeTagsByUrl(rawTags);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
      <SectionIntro
        section={getSection("blog")}
        title="标签"
        description="同一主题的文章聚在一起。点任意标签查看该主题下的全部文章。"
      >
        <p className="text-sm text-muted">
          <span className="font-medium text-foreground">{tags.length}</span> 个标签，
          覆盖 <span className="font-medium text-foreground">{posts.length}</span> 篇文章
        </p>
      </SectionIntro>

      <div className="mt-8">
        {tags.length === 0 ? (
          <EmptyState>还没有任何标签。文章 frontmatter 里的 tags 会出现在这里。</EmptyState>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label="全部标签">
            {tags.map(({ tag, count }) => (
              <li key={tag}>
                {/*
                  用 `<Link>` 而不是 `<button onClick>`：标签页必须能被
                  搜索引擎收录、能被右键新窗口打开、能分享。客户端筛选做不到这些。

                  `title` 给出计数，视觉上计数放在胶囊里 —— 
                  两者都不影响读屏（读屏会读完整文本）。
                */}
                <Link
                  href={tagHref(tag)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm font-medium text-muted transition-colors hover:border-accent/60 hover:text-foreground"
                >
                  {tag}
                  <span className="font-mono text-xs text-muted-deep">{count}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-10 border-t border-border pt-6 text-sm text-muted">
        想按关键词找？去{" "}
        <Link href={SEARCH_PATH} className="text-accent underline-offset-4 hover:underline">
          站内搜索
        </Link>
        。
      </p>
    </div>
  );
}
