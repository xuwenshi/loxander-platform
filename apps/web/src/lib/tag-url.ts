/**
 * 标签页 URL 的**唯一真源**。
 *
 * ── 为什么需要一个单独的文件 ──────────────────────────────────────────
 * P5 验收有一条「标签页 URL 稳定」。这件事看起来只是 `encodeURIComponent`，
 * 实际上有四个必须一起定下来的决定，任何一个散落在页面里都会导致「同一个标签有两个 URL」：
 *
 * 1. **大小写**：标签名原样存（`db/mapping.ts:476` 的 `tagSlugOf` 是恒等函数），
 *    所以库里同时可能有 `"RAG"` 与 `"rag"`（`getAllTags()` 按原字符串计数，
 *    它们就是两个标签）。但 URL 必须归一化到小写，否则
 *    「用户手输 /tags/RAG」与「站内链接 /tags/rag」会成为两个页面，
 *    其中一个渲染空状态 —— 看起来像标签丢了。
 *    → **URL 一律小写**，读回时大小写不敏感匹配（见 `getPostsByTag`）。
 *
 * 2. **空格**：标签里有空格（`"机器学习 基础"`）时，
 *    `encodeURIComponent` 会给 `%20`，而浏览器地址栏显示 `%20`、复制粘贴后仍是 `%20`，
 *    但某些工具会把它变成 `+`（表单编码的遗留）。为了让两种写法都命中，
 *    **解码时把 `+` 也当空格**（见 {@link decodeTagParam}）。
 *
 * 3. **斜杠**：标签里出现 `/`（`"Next.js/React"`）时，
 *    如果直接用标签名做路径段，URL 会多出一级、路由直接不匹配。
 *    → `encodeURIComponent` 会把 `/` 转成 `%2F`，Next 的 `[tag]` 段收到的是**已解码**
 *    的值，所以能正确拿到带斜杠的标签名。但为了让「复制出去再贴回来」也稳，
 *    路径段**必须**用 `encodeURIComponent` 而不是手拼。
 *
 * 4. **空标签 / 纯空白**：`" "` 这种标签在 `zStringSet` 里已被 trim 成 `""` 再丢掉，
 *    理论上不会出现；但库是外部可写的，这里仍做兜底：
 *    {@link tagHref} 遇到归一化后为空的标签返回 `/tags`（列表页），不产生 `/tags/` 这样的坏链接。
 *
 * ── 为什么不做成 `/tags/[slug]` + slug 映射表 ─────────────────────────
 * `db/mapping.ts:456-478` 已经论证过：当前 slug 与 name 恒等，刻意不做 slugify
 * （没有 slugify 工具、中文标签会被安全正则判非法、且当时没有 `/tags` 消费方）。
 * 现在有了消费方，但结论不变：**多一张映射表 = 多一处需要回填的历史数据**。
 * 归一化只做「小写 + 编码」这两件可逆的事，不需要任何持久化。
 */

import type { TagCount } from "@/types";

/** 标签页列表路由。 */
export const TAGS_PATH = "/tags";

/** 搜索页路由。 */
export const SEARCH_PATH = "/search";

/**
 * 把标签名归一化成 URL 片段（**不含前导斜杠**）。
 *
 * 只做两件事：`trim() + toLowerCase()`。**不做** slugify ——
 * 中文标签、含点/加号的标签（`Next.js`、`C++`）都必须原样保留，
 * 任何替换规则都会让「标签名」与「URL」之间失去可逆性。
 *
 * 归一化后为空时返回空串，由 {@link tagHref} 兜底。
 */
export function tagSlugOfName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 标签名 → 站内链接。
 *
 * 归一化后为空的标签返回 {@link TAGS_PATH}，保证永远产出一个可用的链接
 * （而不是 `/tags/`，那个地址在 Next 里会匹配到列表页但带一个空段，
 * 出现在 `href` 里会让人以为有 bug）。
 */
export function tagHref(name: string): string {
  const slug = tagSlugOfName(name);
  if (!slug) return TAGS_PATH;
  return `${TAGS_PATH}/${encodeURIComponent(slug)}`;
}

/**
 * 路由参数 → 用于匹配的标签串。
 *
 * Next 的 `[tag]` 段拿到的已经是 decode 过一次的值（`%2F` 已变回 `/`），
 * 但 `+` 不会被解成空格 —— 所以这里补一手，并把大小写归一。
 * 解析失败（畸形百分号编码，如 `%E4%BD`）时 `decodeURIComponent` 会抛，
 * 这里退回原串而不是抛错：让页面渲染「无此标签」，比 500 更合适。
 *
 * ## 为什么 `+` → `%20` 必须在 `decodeURIComponent` **之前**做
 *
 * 顺序反了会把标签名里的真加号吃掉。以 `C++` 为例：
 * - `tagHref("C++")` → `/tags/c%2B%2B`（`encodeURIComponent` 把 `+` 编码成 `%2B`，正确）
 * - 若先 decode：`c%2B%2B` → `c++`，再 `.replace(/\+/g," ")` → `c  `，`trim()` → `c`（错，标签丢了）
 * - 先替换：`c%2B%2B` 里没有裸 `+`（都是 `%2B`），原样送进 decode → `c++`（对）
 *
 * 反过来 `vector+db`（表单式编码的空格）里是裸 `+`，先替换成 `%20` 再 decode 就得 `vector db`。
 * 两种形态靠「裸 `+` 与 `%2B` 是不同的字符」自然区分开，所以这个顺序是唯一正确的。
 *
 * 这个缺陷是 P5 端到端测试（`p5-e2e.test.ts` 的 `C++` 往返用例）抓出来的：
 * 真实数据里当时还没有含 `+` 的标签，但作者随时可能写出 `C++`、`A/B 测试`这类名字。
 */
export function decodeTagParam(raw: string): string {
  let decoded = raw.replace(/\+/g, "%20");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // 畸形编码：保持替换后的原串，后续匹配自然落空
  }
  return decoded.trim().toLowerCase();
}

/**
 * 判断一个标签名是否匹配 URL 里的标签段（大小写不敏感、空格与 `+` 等价）。
 *
 * 这是「标签页能筛出文章」的核心判据，两个内容源共用同一份实现。
 */
export function tagMatches(name: string, tagParam: string): boolean {
  return tagSlugOfName(name) === decodeTagParam(tagParam);
}

/**
 * 把标签列表按「归一化后的 URL 片段」合并，得到**每个 URL 只有一条**的列表。
 *
 * ── 为什么需要这个函数 ────────────────────────────────────────────────
 * `getAllTags()` 按**原字符串**计数（`"RAG"` 与 `"rag"` 是两个标签，各带各的计数），
 * 而 `tagHref()` 归一化到小写 —— 两者一旦遇到「仅大小写不同」的标签，
 * `/tags` 索引页会渲染出**两个 href 完全相同**的链接，`sitemap.xml` 会出现两条相同 URL。
 * 这正是方案 P5 验收第 3 条「标签页 URL 稳定」要扣分的形态。
 *
 * ── 为什么在消费端合并，而不是改 `getAllTags()` ────────────────────────
 * `getAllTags()` 是**两个内容源共同实现**的接口（markdown 侧 `posts.ts` 与 db 侧
 * `sources/db.ts`），改它要同步改两处实现 + `db/compare.ts` 的等价断言，
 * 否则 markdown / db 双源立刻分叉。而「URL 去重」纯粹是**渲染层**的需求，
 * 放在这里只需要改一个函数，且两个内容源自动一致。
 *
 * ── 合并规则 ──────────────────────────────────────────────────────────
 * - 计数**相加**：`"RAG"` 2 篇 + `"rag"` 1 篇 → 同一个 URL 下 3 篇。这是唯一正确的口径，
 *   因为 `/tags/rag` 页面实际列出的就是这 3 篇（`getPostsByTag` 大小写不敏感）。
 * - 展示名取**第一次出现的原字符串**（顺序由传入列表决定，通常已按计数倒序），
 *   保证展示与「哪个写法用得更多」一致。
 * - 归一化后为空的标签（纯空白）**直接丢弃**：`tagHref` 会把它兜底成 `/tags`，
 *   留在列表里等于在索引页放一个「点回自己」的链接。
 *
 * @param tags `getAllTags()` 的结果（顺序会被保留）
 * @returns 每个归一化 URL 片段对应一条，顺序按首次出现
 */
export function mergeTagsByUrl(tags: readonly TagCount[]): TagCount[] {
  const bySlug = new Map<string, TagCount>();

  for (const { tag, count } of tags) {
    const slug = tagSlugOfName(tag);
    if (!slug) continue;

    const existing = bySlug.get(slug);
    if (existing) {
      // 保留先出现的展示名，只累加计数
      existing.count += count;
    } else {
      bySlug.set(slug, { tag, count });
    }
  }

  return [...bySlug.values()];
}
