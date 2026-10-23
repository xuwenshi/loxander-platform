/**
 * P4 离线测试专用的 `next/cache` 替身。
 *
 * ── 为什么另建一个，而不是复用 `lib/sources/__tests__/next-cache-stub.ts` ──
 * 那个替身**故意不实现** `revalidateTag` / `updateTag` / `revalidatePath`，
 * 注释里写得很清楚：这三个只在 Server Action / Route Handler 里合法，
 * P3 的测试根本不该调到它们，漏了正好能暴露「错误的 import 位置」。
 *
 * 但 P4 的 `lib/admin/actions.ts` 是**真的** Server Action，它必须 import
 * `updateTag` 与 `revalidatePath`。若把这两个加进 P3 的替身，那条保护就没了。
 * 所以这里另建一个：P4 的测试用它，P3 的测试继续用原来那个。
 *
 * ── 为什么记录调用而不是空实现 ─────────────────────────────────────────
 * 「写完之后有没有把该失效的标签失效掉」是 P4 一个真实的验收点
 * （方案 §8.4 第 7 道关）。记录下来就能直接断言，比只看代码强。
 */

/** 本进程内 `updateTag()` 收到的标签（按调用顺序，含重复）。 */
export const updatedTags: string[] = [];

/** 本进程内 `revalidatePath()` 收到的参数。 */
export const revalidatedPaths: { path: string; type?: "page" | "layout" }[] = [];

/** 本进程内 `cacheTag()` 收到的标签（P4 模块若用到也要能跑）。 */
export const recordedTags: string[] = [];

export function updateTag(tag: string): void {
  updatedTags.push(tag);
}

export function revalidatePath(path: string, type?: "page" | "layout"): void {
  revalidatedPaths.push({ path, type });
}

export function cacheTag(...tags: string[]): void {
  recordedTags.push(...tags);
}

export function cacheLife(): void {
  // 生命周期只影响 Next 的缓存策略，对取数结果没有影响。
}

/**
 * `revalidateTag` 故意保留为空实现但**必须存在**：
 * 万一将来有人在 Server Action 里改用 `revalidateTag`，这里不会因为
 * 缺少导出而让整个测试文件崩掉，而是静默通过 —— 代价是那条路径不被覆盖。
 * 需要覆盖时把记录加进来即可。
 */
export function revalidateTag(): void {}

export function refresh(): void {}

export function unstable_noStore(): void {}

/** 清空全部记录，测试用例之间互不干扰。 */
export function resetCacheCalls(): void {
  updatedTags.length = 0;
  revalidatedPaths.length = 0;
  recordedTags.length = 0;
}
