import { CmsError } from '../errors'
import { scanAll, scanSection, type ContentEntry, type SectionSummary } from './entryService'
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

export function listContent(section?: unknown): ContentListPayload {
  const settings = getSettings()
  if (!settings.workspaceRoot) {
    throw new CmsError('WORKSPACE_NOT_FOUND', '尚未配置文件工作区', '请在设置中指定 my-blog 仓库根目录')
  }
  const sections =
    section === undefined
      ? scanAll(settings.workspaceRoot)
      : [scanSection(settings.workspaceRoot, assertSection(section))]
  return { workspaceRoot: settings.workspaceRoot, sections }
}