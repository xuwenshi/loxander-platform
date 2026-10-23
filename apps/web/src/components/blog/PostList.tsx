"use client";

import { useMemo, useState } from "react";

import PostCard from "./PostCard";
import { EmptyState } from "@/components/ui/SectionHeading";
import type { PostMeta } from "@/types";

/** 每页文章数。4 篇的当前体量下一页放得下，这个值是为内容变多后准备的。 */
const PAGE_SIZE = 9;

/**
 * 文章列表 + 标签筛选 + 分页。
 *
 * ── 为什么筛选和分页都在客户端 ──────────────────────────────────────
 * 这是 P1 就定下的设计（见本文件原始注释）：个人博客的文章量级下，
 * 客户端筛选不需要引入搜索服务，也不必把列表页变成动态路由。
 *
 * 分页沿用同一条思路：如果改用 `searchParams` 做服务端分页，`/blog` 会从
 * 静态页变成动态页，`cacheComponents` 下还得额外套一层 `<Suspense>` 兜住
 * 静态外壳 —— 为了 4 篇文章付这个代价不划算。
 *
 * **代价必须写清楚**：客户端分页意味着首屏仍然会把全部文章的元信息
 * 序列化进 RSC payload。当前 4 篇约几 KB，可以接受；等文章到几十上百篇
 * （P5 会加服务端搜索，那时正好一并处理），必须改成服务端分页 +
 * `searchParams`，否则首屏体积会线性增长。
 *
 * ── 翻页与筛选的联动 ────────────────────────────────────────────────
 * 切换标签时页码必须归 1，否则会出现「筛出 2 篇却停在第 3 页」的空列表。
 */
export default function PostList({ posts }: { posts: PostMeta[] }) {
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const tags = useMemo(() => {
    const counter = new Map<string, number>();
    for (const post of posts) {
      for (const tag of post.tags) {
        counter.set(tag, (counter.get(tag) ?? 0) + 1);
      }
    }
    return [...counter.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }, [posts]);

  const visiblePosts = useMemo(
    () => (activeTag ? posts.filter((post) => post.tags.includes(activeTag)) : posts),
    [posts, activeTag],
  );

  const pageCount = Math.max(1, Math.ceil(visiblePosts.length / PAGE_SIZE));

  // 内容变少（切标签）时页码可能越界，这里夹一下而不是用 effect 去 setState ——
  // 在渲染期夹取是纯计算，effect 会多一次渲染并触发闪烁。
  const currentPage = Math.min(page, pageCount);
  const pagePosts = useMemo(
    () => visiblePosts.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [visiblePosts, currentPage],
  );

  /** 切标签时把页码重置回第一页。 */
  function selectTag(tag: string | null) {
    setActiveTag(tag);
    setPage(1);
  }

  if (posts.length === 0) {
    return <EmptyState>还没有文章。内容库里还没有已发布的文章。</EmptyState>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => selectTag(null)}
          aria-pressed={activeTag === null}
          className={`inline-flex min-h-11 items-center rounded-full border px-3.5 text-xs font-medium transition-colors ${
            activeTag === null
              ? "border-accent bg-accent text-on-accent"
              : "border-border bg-surface text-muted hover:text-foreground"
          }`}
        >
          全部（{posts.length}）
        </button>

        {tags.map(([tag, count]) => (
          <button
            key={tag}
            type="button"
            onClick={() => selectTag(tag)}
            aria-pressed={activeTag === tag}
            className={`inline-flex min-h-11 items-center rounded-full border px-3.5 text-xs font-medium transition-colors ${
              activeTag === tag
                ? "border-accent bg-accent text-on-accent"
                : "border-border bg-surface text-muted hover:text-foreground"
            }`}
          >
            {tag}（{count}）
          </button>
        ))}
      </div>

      {visiblePosts.length === 0 ? (
        <EmptyState>该标签下暂时没有文章。</EmptyState>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {pagePosts.map((post) => (
              <PostCard key={post.slug} post={post} />
            ))}
          </div>

          {pageCount > 1 ? (
            <nav
              aria-label="文章分页"
              className="flex flex-wrap items-center justify-center gap-2 border-t border-border pt-6"
            >
              <button
                type="button"
                onClick={() => setPage(currentPage - 1)}
                disabled={currentPage === 1}
                className="inline-flex min-h-11 items-center rounded-full border border-border bg-surface px-4 text-xs font-medium text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                上一页
              </button>

              {Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => (
                <button
                  key={number}
                  type="button"
                  onClick={() => setPage(number)}
                  aria-current={number === currentPage ? "page" : undefined}
                  className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border px-3 text-xs font-medium transition-colors ${
                    number === currentPage
                      ? "border-accent bg-accent text-on-accent"
                      : "border-border bg-surface text-muted hover:text-foreground"
                  }`}
                >
                  {number}
                </button>
              ))}

              <button
                type="button"
                onClick={() => setPage(currentPage + 1)}
                disabled={currentPage === pageCount}
                className="inline-flex min-h-11 items-center rounded-full border border-border bg-surface px-4 text-xs font-medium text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                下一页
              </button>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
