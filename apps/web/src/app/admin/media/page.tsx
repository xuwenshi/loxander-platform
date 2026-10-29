import type { Metadata } from "next";
import { Suspense } from "react";

import { MediaGrid, type MediaGridRow } from "@/components/admin/media-grid";
import { MediaUploadForm } from "@/components/admin/media-upload-form";
import { EmptyState } from "@/components/ui/SectionHeading";
import { hasDatabaseUrl } from "@/lib/admin/db";
import { listMedia } from "@/lib/admin/media";
import { findMediaReferences } from "@/lib/media/references";
import { isBlobConfigured } from "@/lib/media/storage";

export const metadata: Metadata = { title: "媒体" };

/**
 * 媒体库（`/admin/media`）。
 *
 * ── 为什么页面本体是静态外壳 + Suspense ────────────────────────────
 * 与 `/admin/content` 同一理由（见 `content/page.tsx:51-55`）：开了
 * `cacheComponents` 后，页面顶层 await 任何「请求期才知道」的数据（这里是
 * 数据库查询）会让整页退化成阻塞式预渲染，`next build` 报
 * blocking-prerender-runtime。所以外壳先出，查库那段包在 `<Suspense>` 里。
 *
 * 这里**不**声明 `instant` —— `app/admin/layout.tsx:33` 已经在 `/admin` 这一层
 * 声明了 `export const instant = false`，子页面重复声明不会更有效，反而会在
 * 将来 layout 改成 true 时留下一个「隐形覆盖」。
 *
 * ── 为什么不加 `"use cache"` ────────────────────────────────────────
 * 媒体列表的每个条目要算「被引用几次」，而引用数随文章正文变化。缓存它需要
 * 一套失效依赖（哪篇文章改了要打掉哪个缓存），而这张表只有几十行 —— 每次
 * 现查是正确性和复杂度之间的正确取舍。
 */
export default function MediaLibraryPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-xl font-medium tracking-tight text-foreground">媒体</h1>
          <p className="mt-1 text-sm text-muted">
            上传图片并查看引用情况。删除前会检查是否仍被正文或封面引用 —— 被引用的图不允许删。
          </p>
        </div>
      </header>

      <Suspense fallback={<MediaSkeleton />}>
        <MediaBody />
      </Suspense>
    </div>
  );
}

/**
 * 真正查库的那一段。
 *
 * ── N+1 的取舍（刻意留下，但写明代价与解法）────────────────────────
 * 每一行媒体都要问一次「它被谁引用」（`findMediaReferences`）。媒体有 N 张
 * 就是 N 次查询，是典型的 N+1。
 *
 * 当前接受它，因为：①媒体库是个位数到几十张的量级，N 次几十毫秒的查询对
 * 后台页面无感；②反过来「一次查出所有引用关系」需要在 SQL 里对全表 `body_md`
 * 做文本匹配并把结果按图聚合，SQL 复杂度与出错面都显著上升，而现在每次删除
 * 都会独立调用同一个函数，页面与删除两处的判断标准因此**必然一致** ——
 * 这是比性能更重要的性质（页面说「没人引用」，删除却说「有 3 处引用」，是
 * 最难排查的一类 bug）。
 *
 * 将来真要优化：一次性 `select kind, slug, data->>'cover', body_md from entries`，
 * 在内存里建「pathname → 引用列表」的倒排表，然后页面与删除都查这张表。
 * 前提是先用测量证明这里真的慢了 —— 现在没有证据。
 */
async function MediaBody() {
  /*
    没配 DATABASE_URL 时给一句人话，而不是让 `getAdminDb()` 抛出来变成 500。
    文案与 `/admin/content` 一致（那里写「未配置 DATABASE_URL，无法读取内容列表。」）。
  */
  if (!hasDatabaseUrl()) {
    return (
      <p className="mt-6 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        未配置 DATABASE_URL，无法读取媒体库。
      </p>
    );
  }

  const rows = await listMedia();

  /*
    引用数逐张算。这里用 `Promise.all` 而不是 `for await`：几十个查询并发
    发出，总耗时约等于最慢的那个，而串行是它们的和。数据库连接池 `max: 1`
    （`admin/db.ts`）意味着它们其实会排队执行 —— 但那也是排队，不会让代码
    复杂度上升。`allSettled` 不必要：引用查询失败应该让页面报错可见，
    而不是悄悄显示「0 处引用」——那会诱导人去删一张仍在用的图。
  */
  const counts = await Promise.all(
    rows.map(async (row) => (await findMediaReferences(row.path)).length),
  );

  const withCounts: MediaGridRow[] = rows.map((row, index) => ({
    ...row,
    referenceCount: counts[index] ?? 0,
  }));

  return (
    <>
      <StorageNotice />

      <MediaUploadForm />

      {withCounts.length === 0 ? (
        // 复用全站统一的空态组件，别在后台单独造一个近似样式 ——
        // 两处边框虚线的圆角/内边距一旦不一致，以后改样式就要改两遍。
        <div className="mt-6">
          <EmptyState>媒体库还是空的。上传第一张图片后，它会出现在这里。</EmptyState>
        </div>
      ) : (
        <MediaGrid rows={withCounts} />
      )}
    </>
  );
}

/**
 * 存储模式提示。
 *
 * ── 为什么必须显式告诉操作者「现在是本地兜底」───────────────────────
 * 本地兜底写的是 `apps/web/public/media/`。这在开发机上一切正常，图片能显示、
 * 能删除，看起来和 blob 模式毫无区别 —— 于是很容易带着这个配置部署上去，
 * 然后在 Vercel 上收到 `EROFS`（只读文件系统），而报错发生在**上传的那一次
 * 点击**里，不在部署时，排查成本很高。把这件事写在页面上，是唯一能让操作者
 * 在上传之前就知道的地方。
 *
 * 反过来，配了 Token 的情况下不提示 —— 正常状态不该占用视觉注意力。
 */
function StorageNotice() {
  if (isBlobConfigured()) return null;

  return (
    <p className="mt-6 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
      未配置 BLOB_READ_WRITE_TOKEN，图片会写入本地 <code className="font-mono">public/media/</code>。
      这是开发兜底：Vercel 的运行时文件系统只读，部署后上传会失败。上线前必须配置 Blob Token。
    </p>
  );
}

/** Suspense 骨架。高度刻意接近真实内容，避免加载完成时页面跳动。 */
function MediaSkeleton() {
  return (
    <div className="mt-6 space-y-3" aria-busy="true">
      <div className="h-40 animate-pulse rounded-xl border border-border bg-elevated" />
      <div className="h-64 animate-pulse rounded-xl border border-border bg-elevated" />
    </div>
  );
}
