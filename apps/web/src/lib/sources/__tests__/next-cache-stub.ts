/**
 * 测试专用的 `next/cache` 替身。
 *
 * 为什么需要：`lib/sources/db.ts` 的四个 `"use cache"` 函数里调了 `cacheTag()`。
 * 真实实现（`node_modules/next/dist/server/use-cache/cache-tag.js`）第一行就是
 * `if (!process.env.__NEXT_USE_CACHE) throw new Error('`cacheTag()` is only available with the `cacheComponents` config.')`，
 * 而 `__NEXT_USE_CACHE` 只有 Next 的编译器（`next/dist/build/define-env.js:90`）
 * 在构建时才会注入。纯 `node --test` 里它永远是 undefined，
 * 于是任何走到详情路径的测试都会当场抛错 —— 那会让 14 条双实现等价测试全挂，
 * 而我们真正要验的是「两路取数结果等价」，不是「缓存标签是否生效」。
 *
 * 所以这里把 `cacheTag` / `cacheLife` 换成**记录参数的空实现**：
 * 测试可以顺便断言「打了哪些标签」，这比单纯屏蔽更有价值。
 * 注意不要在这里实现 `revalidateTag` —— 它只在 Server Action / Route Handler
 * 里合法，测试里根本不该被调到，漏了正好能暴露错误的 import 位置。
 */

/** 本进程内被 `cacheTag()` 打过的标签（按调用顺序）。 */
export const recordedTags: string[] = [];

export function cacheTag(...tags: string[]): void {
  recordedTags.push(...tags);
}

export function cacheLife(): void {
  // 生命周期只影响 Next 的缓存策略，对取数结果没有影响，测试里无需记录。
}

/** 清空记录，测试用例之间互不干扰。 */
export function resetRecordedTags(): void {
  recordedTags.length = 0;
}
