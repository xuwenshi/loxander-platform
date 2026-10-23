import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import PostCard from "@/components/blog/PostCard";
import SectionIntro from "@/components/cosmic/SectionIntro";
import { SearchIcon } from "@/components/ui/Icons";
import { EmptyState } from "@/components/ui/SectionHeading";
import { getSection } from "@/lib/cosmic";
import { getAllPosts, searchPosts } from "@/lib/content";
import { SEARCH_MAX_QUERY_LENGTH, tokenizeQuery } from "@/lib/search";
import { TAGS_PATH } from "@/lib/tag-url";

/**
 * 站内搜索页 `/search?q=...`（P5 新增）。
 *
 * ── 为什么搜索走服务端 ──────────────────────────────────────────────
 * 方案 §11 P5 明确要求「服务端搜索」，§14.2 又把「搜索」单列为「动态查询」。
 * 客户端搜索要么把全部正文塞进 bundle（几 MB），要么只搜元信息（搜不到正文里的
 * 关键标识符，比如 `useCache`、`revalidateTag` —— 而那正是用户最常搜的东西）。
 *
 * ── 为什么外壳与正文要拆开 ──────────────────────────────────────────
 * `cacheComponents: true` 下，任何 `await searchParams` 都会把整页变成动态渲染，
 * 而动态渲染的页面在构建期无法预渲染外壳 —— 直接写会报
 * 「Route couldn't be prerendered」。
 * 解法与 `/admin/content` 一致：默认导出只渲染**静态外壳**（页头 + 搜索框），
 * 把读 `searchParams` 的部分放进 `<Suspense>` 里的子组件。
 * 这样外壳（含表单）能预渲染，结果区按请求流式补齐。
 *
 * ── 匹配与排序在哪 ──────────────────────────────────────────────────
 * 全部在 `lib/search.ts`（纯函数）：分词 → AND 匹配 → 字段加权打分 →
 * 得分降序 / 日期降序 / slug 升序。本页只负责取参数、调内容源、渲染。
 *
 * ── 「只返回已发布」由谁保证 ────────────────────────────────────────
 * 由内容源实现保证（markdown 源过滤草稿，db 源生产环境套 `visibleOnly()`），
 * 本页**不重复过滤**。`p5-wiring.test.ts` 有一条用例专门守这条边界。
 */

export const metadata: Metadata = {
  title: "搜索",
  description: "站内搜索：按标题、标签、分类、摘要与正文关键词查找文章。",
  alternates: { canonical: "/search" },
  // 搜索结果页是动态的，每一条 query 都是一个 URL，不该被索引。
  robots: { index: false, follow: true },
};

type SearchPageProps = {
  searchParams: Promise<{ q?: string | string[] }>;
};

export default function SearchPage({ searchParams }: SearchPageProps) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
      <SectionIntro
        section={getSection("blog")}
        title="搜索"
        description="按标题、标签、分类、摘要和正文关键词查找文章。多个关键词用空格分隔，结果需要同时命中全部关键词。"
      >
        {/*
          用原生 `<form method="get">` 而不是 Server Action 或客户端 onSubmit：
          搜索是**读操作**，条件必须落在 URL 里 —— 这样结果页可刷新、可分享、
          可前进后退。用 action 会导致「刷新后回到空表单」。
        */}
        <form action="/search" method="get" role="search" className="flex flex-wrap gap-2">
          <label htmlFor="q" className="sr-only">
            搜索关键词
          </label>
          <div className="relative flex-1 min-w-[16rem]">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-deep">
              <SearchIcon width={16} height={16} />
            </span>
            <input
              id="q"
              name="q"
              type="search"
              /*
                `maxLength` 与服务端 `SEARCH_MAX_QUERY_LENGTH` 必须一致：
                前端限制只是体验，真正的约束在 `normalizeQuery()` 里 ——
                用户完全可以直接改 URL 绕过 maxLength。
              */
              maxLength={SEARCH_MAX_QUERY_LENGTH}
              placeholder="例：RAG、向量检索、缓存"
              autoComplete="off"
              className="min-h-11 w-full rounded-full border border-border bg-surface pl-9 pr-4 text-sm text-foreground placeholder:text-muted-deep focus:border-border-focus focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-full border border-accent bg-accent px-5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover"
          >
            搜索
          </button>
        </form>
      </SectionIntro>

      <div className="mt-8">
        <Suspense fallback={<SearchSkeleton />}>
          <SearchResults searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}

/** 结果区的静态骨架：形状与真实结果的网格一致，避免加载时页面跳动。 */
function SearchSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <p className="text-sm text-muted">正在搜索…</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1].map((key) => (
          <div
            key={key}
            className="h-40 animate-pulse rounded-xl border border-border bg-surface"
          />
        ))}
      </div>
    </div>
  );
}

/** 真正的结果区：唯一读 `searchParams` 的地方（因此它是动态的）。 */
async function SearchResults({ searchParams }: SearchPageProps) {
  const params = await searchParams;

  /*
    `searchParams` 的值可能是 `string` 也可能是 `string[]`（`?q=a&q=b`）。
    取第一个并收敛成字符串 —— 这不是「随便兜底」，而是明确只接受一个查询词，
    多出来的忽略。写成 `Array.isArray` 判断比 `String(params.q)` 诚实：
    后者会把数组拼成 `"a,b"`，搜索词里凭空多一个逗号。
  */
  const raw = Array.isArray(params.q) ? (params.q[0] ?? "") : (params.q ?? "");
  const tokens = tokenizeQuery(raw);

  // 没输入任何可搜索的词：不是错误，只是还没搜。
  if (tokens.length === 0) {
    const total = (await getAllPosts()).length;
    return (
      <EmptyState>
        输入关键词开始搜索。当前可搜索的文章共 <strong>{total}</strong> 篇。
      </EmptyState>
    );
  }

  const results = await searchPosts(raw);

  if (results.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          关键词 <span className="font-medium text-foreground">{tokens.join(" ")}</span>{" "}
          没有匹配到任何文章。
        </p>
        <EmptyState>
          试试更短的关键词，或去{" "}
          <Link href={TAGS_PATH} className="text-accent underline-offset-4 hover:underline">
            标签页
          </Link>{" "}
          按主题浏览。
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted" role="status">
        关键词 <span className="font-medium text-foreground">{tokens.join(" ")}</span> 匹配到{" "}
        <span className="font-medium text-foreground">{results.length}</span> 篇文章
      </p>

      {/*
        `aria-live="polite"` 在 `role="status"` 上已经隐式存在，
        这里显式写出来是为了让「结果数量变化」能被读屏播报 ——
        搜索是典型的「提交后内容在原地变化」的场景。
      */}
      <h2 className="sr-only">搜索结果</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {results.map((post) => (
          <PostCard key={post.slug} post={post} />
        ))}
      </div>
    </div>
  );
}
