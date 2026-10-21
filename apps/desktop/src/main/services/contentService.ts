import { CmsError } from '../errors'
import { scanAll, scanSection, type ContentEntry, type SectionSummary } from './entryService'
import { groupIdOf, groupsOf } from './groupService'
import { assertSection, CONTENT_SECTIONS, type ContentSection } from './schemaService'
import { getSettings } from './settingsService'

/**
 * 内容服务（薄封装）：把「工作区根从设置里解析出来」与纯 fs 的 entryService 分开，
 * 使 entryService 可以在不启动 electron 的情况下被单测覆盖。
 */

export type { ContentEntry, SectionSummary }
export { assertSection, CONTENT_SECTIONS }
export type { ContentSection }

export interface ContentListPayload {
  workspaceRoot: string
  sections: SectionSummary[]
}

/**
 * 内容清单 = 磁盘扫描结果 + CMS 侧虚拟分组元数据。
 * 合并放在这一层而不是 entryService：扫描层保持「纯 fs」，分组来自 settings，只有这里同时握有两边。
 * 悬空归属（指向已删除的分组）会在 groupIdOf 里退化为 null。
 */
export function listContent(section?: unknown): ContentListPayload {
  const settings = getSettings()
  if (!settings.workspaceRoot) {
    throw new CmsError('WORKSPACE_NOT_FOUND', '尚未配置文件工作区', '请在设置中指定 my-blog 仓库根目录')
  }
  const scanned =
    section === undefined
      ? scanAll(settings.workspaceRoot)
      : [scanSection(settings.workspaceRoot, assertSection(section))]

  const sections: SectionSummary[] = scanned.map((summary) => ({
    ...summary,
    groups: groupsOf(settings.groups, summary.section),
    entries: summary.entries.map((entry) => ({
      ...entry,
      groupId: groupIdOf(settings.groups, summary.section, entry.slug)
    }))
  }))

  return { workspaceRoot: settings.workspaceRoot, sections }
}