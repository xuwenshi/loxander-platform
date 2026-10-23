import { getAllPosts } from "@/lib/content";
import { siteConfig } from "@/lib/site";

/**
 * `/rss.xml` —— 全站文章订阅源（RSS 2.0）。
 *
 * ── 为什么手写 XML 而不引第三方库 ────────────────────────────────────
 * `feed` / `rss` 这类包为了覆盖 Atom / JSON Feed / 各种扩展字段，体积都在
 * 几十 KB 以上，而这里只需要 10 个元素。更关键的是**转义必须自己说了算**：
 * 标题里出现 `&`、`<`、`"` 时若依赖库的默认行为，很容易产出浏览器解析不了的
 * XML（这不是理论风险，站内文章标题里就带 `&`）。
 *
 * ── 为什么只输出元信息不输出全文 ────────────────────────────────────
 * `getAllPosts()` 返回的是 `PostMeta`，不含渲染后的 HTML；要拿全文得对每篇
 * 调一次 `getPost()`，那是 4 次 Shiki 高亮 —— 构建期白白多花几百毫秒。
 * `<description>` 用 summary 已经足够订阅器展示，点进去才是完整页面。
 *
 * ── 缓存 ────────────────────────────────────────────────────────────
 * 这是 Route Handler，走 `cacheComponents` 下的动态执行，不在这里声明
 * `"use cache"`：RSS 被订阅器拉取的频率远低于页面，且内容变更本就该立刻反映。
 * 需要加缓存时应在 P4 发布流程里配合 `revalidateTag(ALL_ENTRIES_TAG, "max")` 一起做。
 */

/** XML 文本转义：`&` 必须最先替换，否则会把后面刚生成的实体再转一遍。 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * `YYYY-MM-DD` → RFC 822 / RFC 1123 时间串（RSS 2.0 的 `pubDate` 要求格式）。
 *
 * 内容里的日期是纯日期，没有时区信息。这里统一按 UTC 零点解释，与
 * `lib/format.ts:24` 的处理保持一致 —— 两处若不一致，会出现「页面显示 10 月 8 日、
 * RSS 里写成 10 月 7 日」这种前后矛盾的输出。
 */
function toRfc822(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return new Date(0).toUTCString();

  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return new Date(0).toUTCString();

  return parsed.toUTCString();
}

export async function GET(): Promise<Response> {
  const base = siteConfig.url.replace(/\/$/, "");
  const posts = await getAllPosts();

  // 只取最近 20 篇：RSS 不是归档，把 4 篇全塞进去和 20 篇的体验一样，
  // 但将来文章多了以后，全量会让订阅器每次拉取都变大。
  const recent = posts.slice(0, 20);

  const items = recent
    .map((post) => {
      const url = `${base}/blog/${post.slug}`;
      const categories = [post.category, ...post.tags]
        .filter((value) => value.length > 0)
        .map((value) => `      <category>${escapeXml(value)}</category>`)
        .join("\n");

      return [
        "    <item>",
        `      <title>${escapeXml(post.title)}</title>`,
        `      <link>${escapeXml(url)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
        `      <pubDate>${toRfc822(post.date)}</pubDate>`,
        `      <description>${escapeXml(post.description)}</description>`,
        categories,
        "    </item>",
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    })
    .join("\n");

  // 最近更新取第一篇文章的日期（getAllPosts 已按 date 倒序）。
  const lastBuildDate = recent.length > 0 ? toRfc822(recent[0].date) : new Date().toUTCString();

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(siteConfig.name)}</title>`,
    `    <link>${escapeXml(base)}</link>`,
    `    <description>${escapeXml(siteConfig.description)}</description>`,
    "    <language>zh-CN</language>",
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    `    <atom:link href="${escapeXml(`${base}/rss.xml`)}" rel="self" type="application/rss+xml" />`,
    items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      // 一小时：订阅器通常 15–60 分钟拉一次，太短会让每个订阅器都打到数据库。
      "Cache-Control": "public, max-age=3600",
    },
  });
}
