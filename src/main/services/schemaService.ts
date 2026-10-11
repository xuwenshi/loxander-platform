import { CmsError } from '../errors'

/**
 * 四分区 frontmatter 契约（自建 schema，见 ADR-2）。
 * 与博客仓库零耦合：这里逐字复制 [electron-cms-architecture-plan.md](../../../electron-cms-architecture-plan.md) §1.3 的契约，
 * 由 schema.contract.test.ts 用真实内容做「契约测试」锁死漂移。
 */

export const CONTENT_SECTIONS = ['blog', 'diary', 'projects', 'goals'] as const
export type ContentSection = (typeof CONTENT_SECTIONS)[number]

export type FieldKind = 'string' | 'date' | 'enum' | 'boolean' | 'number' | 'stringArray' | 'milestones'

export interface FieldSpec {
  key: string
  /** 表单展示名（中文） */
  label: string
  kind: FieldKind
  required?: boolean
  /** enum 的合法取值 */
  options?: string[]
  min?: number
  max?: number
  /** 越界时是否自动夹取（对齐站点 toProgress 的「自动纠正并提示」） */
  clamp?: boolean
  help?: string
  /** 数字字段缺省值（如 order 的 999） */
  fallback?: number
}

export interface SectionSchema {
  section: ContentSection
  fields: FieldSpec[]
  /** 全量重排（降级路径）时的字段书写顺序，对齐现有内容的习惯顺序 */
  order: string[]
  /** 该分区是否禁止删空（Next 16 `generateStaticParams` 不接受空数组） */
  minCount: number
}

const blog: SectionSchema = {
  section: 'blog',
  order: ['title', 'description', 'date', 'category', 'tags', 'cover', 'draft'],
  minCount: 1,
  fields: [
    { key: 'title', label: '标题', kind: 'string', required: true },
    { key: 'description', label: '摘要', kind: 'string', required: true, help: '列表与 SEO 描述' },
    { key: 'date', label: '日期', kind: 'date', required: true, help: 'YYYY-MM-DD' },
    { key: 'category', label: '分类', kind: 'string', help: '缺省「未分类」' },
    { key: 'tags', label: '标签', kind: 'stringArray' },
    { key: 'cover', label: '封面', kind: 'string', help: '以 / 开头且 .svg 结尾，须存在于 public/' },
    { key: 'draft', label: '草稿', kind: 'boolean', help: '生产构建会隐藏 draft: true' }
  ]
}

const diary: SectionSchema = {
  section: 'diary',
  order: ['date', 'title', 'summary', 'mood', 'tags', 'draft'],
  minCount: 1,
  fields: [
    { key: 'title', label: '标题', kind: 'string', required: true },
    { key: 'summary', label: '摘要', kind: 'string', required: true },
    { key: 'date', label: '日期', kind: 'date', required: true, help: 'YYYY-MM-DD' },
    { key: 'mood', label: '心情', kind: 'string' },
    { key: 'tags', label: '标签', kind: 'stringArray' },
    { key: 'draft', label: '草稿', kind: 'boolean' }
  ]
}

const projects: SectionSchema = {
  section: 'projects',
  order: [
    'name',
    'description',
    'status',
    'techStack',
    'period',
    'role',
    'github',
    'demo',
    'article',
    'featured',
    'order'
  ],
  minCount: 1,
  fields: [
    { key: 'name', label: '项目名', kind: 'string', required: true },
    { key: 'description', label: '描述', kind: 'string', required: true },
    {
      key: 'status',
      label: '状态',
      kind: 'enum',
      required: true,
      options: ['active', 'in-progress', 'completed', 'archived']
    },
    { key: 'techStack', label: '技术栈', kind: 'stringArray' },
    { key: 'period', label: '周期', kind: 'string' },
    { key: 'role', label: '角色', kind: 'string' },
    { key: 'github', label: 'GitHub', kind: 'string' },
    { key: 'demo', label: 'Demo', kind: 'string' },
    { key: 'article', label: '关联文章', kind: 'string', help: 'blog slug' },
    { key: 'featured', label: '首页精选', kind: 'boolean' },
    { key: 'order', label: '排序', kind: 'number', fallback: 999 }
  ]
}

const goals: SectionSchema = {
  section: 'goals',
  order: ['title', 'horizon', 'status', 'progress', 'period', 'order', 'milestones'],
  minCount: 0,
  fields: [
    { key: 'title', label: '目标', kind: 'string', required: true },
    { key: 'horizon', label: '时间维度', kind: 'enum', required: true, options: ['short', 'mid', 'long'] },
    {
      key: 'status',
      label: '状态',
      kind: 'enum',
      required: true,
      options: ['planned', 'active', 'done', 'paused']
    },
    { key: 'progress', label: '进度', kind: 'number', min: 0, max: 100, clamp: true },
    { key: 'period', label: '周期', kind: 'string' },
    { key: 'order', label: '排序', kind: 'number', fallback: 999 },
    { key: 'milestones', label: '里程碑', kind: 'milestones' }
  ]
}

export const SECTION_SCHEMAS: Record<ContentSection, SectionSchema> = { blog, diary, projects, goals }

export function assertSection(value: unknown): ContentSection {
  if (typeof value !== 'string' || !(CONTENT_SECTIONS as readonly string[]).includes(value)) {
    throw new CmsError(
      'INVALID_SECTION',
      `未知内容分区：${String(value)}`,
      `允许值：${CONTENT_SECTIONS.join(' / ')}`
    )
  }
  return value as ContentSection
}

export function schemaOf(section: ContentSection): SectionSchema {
  return SECTION_SCHEMAS[section]
}

export function fieldSpec(section: ContentSection, key: string): FieldSpec | undefined {
  return SECTION_SCHEMAS[section].fields.find((field) => field.key === key)
}