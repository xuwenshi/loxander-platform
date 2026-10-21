import {
  parseEntry,
  type EntryKind,
  type EntryOf,
  type ParseOptions,
} from "@loxander/content-core";

/**
 * 把 `@loxander/content-core` 的三段式结果接成站点侧的「要么拿到数据，要么抛错」。
 *
 * 为什么要这层适配：
 * - content-core 返回 `{ data?, blocking, warnings }`，是为 desktop 编辑器设计的
 *   （可以边改边显示提示）。站点是构建期读取，没有交互机会，只能二选一。
 * - 站点的既有行为是**快速失败**：frontmatter 写错就让构建报错并指出文件名。
 *   这里保持该行为，避免「静默用默认值兜过去、线上才发现内容丢了」。
 *
 * warning 不阻断（如 cover 文件不存在、article 指向不存在的文章），
 * 只在开发环境打印，因为站点这两种情况都能正常渲染。
 */
export function parseOrThrow<K extends EntryKind>(
  kind: K,
  raw: unknown,
  file: string,
  options: ParseOptions = {},
): EntryOf<K> {
  const result = parseEntry(kind, raw, options);

  if (result.blocking.length > 0) {
    const detail = result.blocking
      .map((issue) =>
        issue.field ? `${issue.field}: ${issue.message}` : issue.message,
      )
      .join("；");
    throw new Error(`[content/${kind}/${file}] frontmatter 校验失败 —— ${detail}`);
  }

  if (process.env.NODE_ENV !== "production") {
    for (const warning of result.warnings) {
      const field = warning.field ? `${warning.field}: ` : "";
      const hint = warning.hint ? `（${warning.hint}）` : "";
      console.warn(`[content/${kind}/${file}] ${field}${warning.message}${hint}`);
    }
  }

  // parseEntry 的实现保证：blocking 为空时 data 一定存在。
  return result.data as EntryOf<K>;
}
