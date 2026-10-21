import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

/**
 * 测试夹具：指向 monorepo 内 `apps/web/content/` 的**真实内容**（只读，绝不写入）。
 *
 * 为什么用真实内容而不是自造样例：这层的价值在于「站点与桌面端渲染同一批文件得到同样结果」，
 * 自造样例无法证明真实内容能通过。真实内容的路径解析：
 * 本文件在 `packages/markdown/src/__tests__/` 下，向上四级回到 monorepo 根，
 * 再进 `apps/web/content`。
 */
export const CONTENT_ROOT = resolve(
  fileURLToPath(new URL('../../../../apps/web/content', import.meta.url)),
);

/** 内容分区名，与 `apps/web/content/` 下的目录一一对应。 */
export const CONTENT_KINDS = ['blog', 'projects', 'diary', 'goals'] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

/** 一篇真实内容：slug、分区、原始 Markdown 正文。 */
export interface ContentSample {
  kind: ContentKind;
  slug: string;
  body: string;
}

/**
 * 列出全部真实内容的正文。
 *
 * 只取 `.md` 文件，正文部分与站点一致地走 `gray-matter` 剥离 frontmatter。
 */
export function listContentSamples(): ContentSample[] {
  const samples: ContentSample[] = [];

  for (const kind of CONTENT_KINDS) {
    const dir = join(CONTENT_ROOT, kind);
    const files = readdirSync(dir).filter((name) => name.endsWith('.md'));

    for (const file of files) {
      const raw = readFileSync(join(dir, file), 'utf8');
      samples.push({
        kind,
        slug: file.replace(/\.md$/, ''),
        body: matter(raw).content,
      });
    }
  }

  return samples;
}
