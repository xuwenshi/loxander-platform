import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTENT_SECTIONS, type ContentSection } from '../schemaService'

/**
 * 测试夹具：指向站点的真实 content/（只读，绝不写入）。
 * P0 导入 monorepo 后内容随站点一起搬到了 apps/web，这里必须跟着走，
 * 否则测试会去找一个不存在的 apps/my-blog/content 并抛 ENOENT。
 */
export const CONTENT_ROOT = resolve(fileURLToPath(new URL('../../../../../web/content', import.meta.url)))
/** 站点 public/，供封面存在性校验用（content/ 的同级目录） */
export const PUBLIC_ROOT = resolve(CONTENT_ROOT, '..', 'public')

export interface ContentFile {
  section: ContentSection
  slug: string
  file: string
  text: string
}

export function listContentFiles(): ContentFile[] {
  const out: ContentFile[] = []
  for (const section of CONTENT_SECTIONS) {
    const dir = join(CONTENT_ROOT, section)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue
      const file = join(dir, name)
      out.push({ section, slug: name.replace(/\.md$/, ''), file, text: readFileSync(file, 'utf8') })
    }
  }
  return out
}