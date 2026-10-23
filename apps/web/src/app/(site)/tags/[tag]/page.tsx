import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import PostList from "@/components/blog/PostList";
import SectionIntro from "@/components/cosmic/SectionIntro";
import { ArrowLeftIcon } from "@/components/ui/Icons";
import { EmptyState } from "@/components/ui/SectionHeading";
import { getSection } from "@/lib/cosmic";
import { getAllTags, getPostsByTag } from "@/lib/content";
import { decodeTagParam, TAGS_PATH, tagHref, tagSlugOfName } from "@/lib/tag-url";

/**
 * 单个标签页 `/tags/[tag]`（P5 新增）。
 *
 * ── 为什么 `params` 是 `Promise` ────────────────────────────────────
 * Next 16 把页面 `params` / `searchParams` 都改成了 Promise（文档
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md`），
 * 必须 `await`。`cacheComponents` 模式下这一点是硬性的，不做会直接报错。
 *
 * ── 归一化在哪做 ────────────────────────────────────────────────────
 * 页面只调 `decodeTagParam()` 与 `tagHref()` / `tagSlugOfName()`，
 * **不自己写 `toLowerCase` 或 `decodeURIComponent`**。原因：
 * 这三件事（小写、`+` 当空格、畸形编码兜底）的规则必须与
 * `TagLink`、`/tags` 总览页、以及 `tagMatches()` 完全一致，
 * 任何一处自己写就多了一份实现，`/tags/RAG` 与 `/tags/rag` 迟早分叉。
 *
 * ── 404 的判据 ──────────────────────────────────────────────────────
 * 用「归一化后的 slug 在 `getAllTags()` 里存在」判定，而不是
 * 「`getPostsByTag()` 返回非空」。理由：后者会把「标签存在但暂时没有文章」
 * 也变成 404，而标签页是长期 URL，不该因为一篇临时删掉的文章消失。
 *
 * ── 缓存 ────────────────────────────────────────────────────────────
 * 不自己声明 `"use cache"`：数据来自 `getAllPostsCached()`（已有
 * `entries:blog` + `entries:all` 标签），发布/归档时会被 `updateTag` 失效。
 */

type TagPageProps = {
  params: Promise<{ tag: string }>;
};

/**
 * 构建期枚举全部标签页。
 *
 * 用 `getAllTags()` 而不是从 `getAllPosts()` 里摊平，理由：前者已经做过去重与计数，
 * 是「标签集合」的唯一来源；从 posts 再摊一次等于把这个逻辑写两遍。
 * URL 段用小写的 `tagSlugOfName()`，与 `tagHref()` 生成的完全一致。
 */
export async function generateStaticParams() {
  const tags = await getAllTags();
  return tags.map(({ tag }) => ({ tag: tagSlugOfName(tag) }));
}

export async function generateMetadata({ params }: TagPageProps): Promise<Metadata> {
  const { tag } = await params;
  const param = decodeTagParam(tag);

  // 用标签集合校验，与页面正文同一个判据（避免 metadata 与页面不一致）。
  const known = (await getAllTags()).find(
    ({ tag: name }) => tagSlugOfName(name) === param,
  );
  if (!known) return { title: "标签不存在" };

  return {
    title: `标签：${known.tag}`,
    description: `标签「${known.tag}」下的 ${known.count} 篇文章。`,
    alternates: { canonical: tagHref(known.tag) },
  };
}

export default async function TagPage({ params }: TagPageProps) {
  const { tag } = await params;
  const param = decodeTagParam(tag);

  const [tags, posts] = await Promise.all([getAllTags(), getPostsByTag(param)]);

  // 标签存在性以「标签集合」为准，不以「文章数 > 0」为准（见文件头）。
  const known = tags.find(({ tag: name }) => tagSlugOfName(name) === param);
  if (!known) notFound();

  // 空标签仍然正常渲染（200 + 空状态），不是 404。
  const displayName = known!.tag;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
      <SectionIntro
        section={getSection("blog")}
        title={`标签：${displayName}`}
        description={
          posts.length > 0
            ? `标签「${displayName}」下共有 ${posts.length} 篇文章，按发布时间从新到旧排列。`
            : `标签「${displayName}」目前还没有文章。`
        }
      >
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href={TAGS_PATH}
            className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
          >
            <ArrowLeftIcon width={15} height={15} />
            全部标签
          </Link>
          <Link
            href="/blog"
            className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
          >
            全部文章
          </Link>
        </div>
      </SectionIntro>

      <div className="mt-8">
        <h2 className="sr-only">{displayName} 下的全部文章</h2>
        {posts.length === 0 ? (
          <EmptyState>
            标签「{displayName}」下还没有文章。
            {/*
              这里刻意不提供"换个标签"的按钮列表：那需要在服务端再渲染一遍
              全量标签，与 `/tags` 页重复。给一条链接就够。
            */}
          </EmptyState>
        ) : (
          /*
            直接复用 `/blog` 的 `PostList`。
            它内部的标签筛选按钮在这一页仍然可用（等于二次筛选），
            副作用是「点另一个标签仍在本页筛」而不是跳到那个标签页 ——
            这是已知的小瑕疵，但不是错误：页面顶部有「全部标签」入口。
            不为此单独造一个简化版列表组件，因为那会让两处列表行为分叉。
          */
          <PostList posts={posts} />
        )}
      </div>
    </div>
  );
}
