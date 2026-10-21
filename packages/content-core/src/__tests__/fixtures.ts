import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

import { ENTRY_KINDS, type EntryKind } from '../kinds';

/**
 * 测试夹具：指向 monorepo 内 `apps/web/content/` 的**真实内容**（只读，绝不写入）。
 *
 * 注意：这里曾经指向旧仓库 `my-blog/content`（electron-cms 时期的做法），
 * 迁移到 monorepo 后必须指向 `apps/web/content`，否则 P1 测试会依赖一个
 * 「P0 已宣布只读、未来会下线」的目录。
 *
 * 路径解析：本文件在 packages/content-core/src/__tests__/ 下，
 * 向上四级到 monorepo 根，再进 apps/web/content。
 */
export const CONTENT_ROOT = resolve(
  fileURLToPath(new URL('../../../../apps/web/content', import.meta.url)),
);

/** public/ 根目录，用于 cover 存在性校验。 */
export const PUBLIC_ROOT = resolve(
  fileURLToPath(new URL('../../../../apps/web/public', import.meta.url)),
);

export interface ContentFile {
  kind: EntryKind;
  slug: string;
  file: string;
  /** 原始 Markdown 文本 */
  text: string;
  /** gray-matter 解析后的 frontmatter（date 会变成 Date 对象） */
  data: Record<string, unknown>;
}

/** 列出全部真实内容文件。 */
export function listContentFiles(): ContentFile[] {
  const out: ContentFile[] = [];
  for (const kind of ENTRY_KINDS) {
    const dir = join(CONTENT_ROOT, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const file = join(dir, name);
      const text = readFileSync(file, 'utf8');
      out.push({
        kind,
        slug: name.replace(/\.md$/, ''),
        file,
        text,
        data: matter(text).data as Record<string, unknown>,
      });
    }
  }
  return out;
}

/** 已知的 blog slug 列表，用于校验 projects.article 引用完整性。 */
export function knownBlogSlugs(): string[] {
  return listContentFiles()
    .filter((item) => item.kind === 'blog')
    .map((item) => item.slug);
}

/** public/ 下某相对路径是否存在。 */
export function publicFileExists(relativePath: string): boolean {
  return existsSync(join(PUBLIC_ROOT, relativePath.replace(/^\//, '')));
}
