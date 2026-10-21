import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTENT_SECTIONS, type ContentSection } from '../schemaService'

/** 测试夹具：直接指向真实博客仓库的 content/（只读，绝不写入） */
export const CONTENT_ROOT = resolve(fileURLToPath(new URL('../../../../../my-blog/content', import.meta.url)))

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