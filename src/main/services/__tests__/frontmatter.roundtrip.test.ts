import { describe, expect, it } from 'vitest'
import { parseDocument, normalizeValue } from '../frontmatterService'
import { planPatch } from '../contentPatchService'
import { CONTENT_SECTIONS, schemaOf } from '../schemaService'
import { listContentFiles } from './fixtures'

/**
 * P1 门禁之一：**往返幂等**。
 * 对全部真实内容，把「当前值」原样 patch 回去必须得到逐字节相同的文件；
 * 这同时证明了「未被编辑的字段不会被重新序列化、不会产生 Git 噪声」。
 *
 * 注意：真实内容篇数会随作者增删而变，这里只用「结构不变量」做前置条件，
 * 不写死篇数，避免新增/删除一篇 Markdown 就让门禁红灯。
 */

describe('roundtrip 幂等（真实内容）', () => {
  const files = listContentFiles()

  it('覆盖全部真实内容且包含每个已声明分区', () => {
    expect(files.length).toBeGreaterThan(0)
    const covered = new Set(files.map((item) => item.section))
    for (const section of CONTENT_SECTIONS) {
      expect(covered.has(section), `缺少分区 ${section}`).toBe(true)
    }
  })

  it('空 patch 不改变任何字节', () => {
    for (const item of files) {
      const doc = parseDocument(item.text)
      const outcome = planPatch(doc, {})
      expect(outcome.changed, `${item.section}/${item.slug}`).toBe(false)
      expect(outcome.text, `${item.section}/${item.slug}`).toBe(item.text)
    }
  })

  it('把当前值原样 patch 回去仍是逐字节相同（幂等）', () => {
    for (const item of files) {
      const doc = parseDocument(item.text)
      // 以 schema 声明顺序构造「当前值」patch，值统一归一（Date → YYYY-MM-DD）
      const patch: Record<string, unknown> = {}
      for (const spec of schemaOf(item.section).fields) {
        if (!Object.prototype.hasOwnProperty.call(doc.data, spec.key)) continue
        patch[spec.key] = normalizeValue(doc.data[spec.key])
      }
      const outcome = planPatch(doc, patch)
      expect(outcome.text, `${item.section}/${item.slug} 幂等失败`).toBe(item.text)
      expect(outcome.changed, `${item.section}/${item.slug}`).toBe(false)
      expect(outcome.skipped.length, `${item.section}/${item.slug}`).toBe(Object.keys(patch).length)
    }
  })

  it('二次 patch 不产生新的差异（写回后保持稳定）', () => {
    for (const item of files) {
      const doc = parseDocument(item.text)
      const first = planPatch(doc, { title: `${String(doc.data.title ?? '')}（改）` })
      const second = planPatch(parseDocument(first.text), {})
      expect(second.text, `${item.section}/${item.slug}`).toBe(first.text)
    }
  })
})