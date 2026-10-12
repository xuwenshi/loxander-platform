import type { ColorScheme, EditorLayout, ThemeMode } from '../../preload/api'

/**
 * 主题分两条正交的轴：
 *   - 模式（themeMode）：决定布局形态 + 主题色（强调色）
 *   - 明暗（colorScheme）：决定中性色板与状态色
 * 二者只是 <html> 上的两个 data 属性，颜色全部由 styles.css 的 CSS 变量层提供。
 */
export interface ThemeModeMeta {
  mode: ThemeMode
  label: string
  hint: string
  /** 主壳 grid 列模板（Tailwind 任意值工具类，布局层） */
  columns: string
  /** 侧栏折叠时的列模板（只让第一列变窄） */
  columnsCollapsed: string
  /** 是否渲染左侧导航 */
  showSidebar: boolean
  /** 是否渲染条目列表列 */
  showEntries: boolean
  /** 主区域渲染什么 */
  mainPane: 'editor' | 'dashboard' | 'publish'
  /** 编辑模式是否显示 frontmatter 表单列 */
  showForm: boolean
}

export const THEME_MODE_META: readonly ThemeModeMeta[] = [
  {
    mode: 'soft',
    label: '柔和编辑',
    hint: 'Markdown 编辑 + 实时预览',
    columns: 'grid-cols-[200px_264px_1fr]',
    columnsCollapsed: 'grid-cols-[56px_264px_1fr]',
    showSidebar: true,
    showEntries: true,
    mainPane: 'editor',
    showForm: true
  },
  {
    mode: 'dashboard',
    label: '管理控制台',
    hint: '内容清单 / 统计 / 操作记录',
    columns: 'grid-cols-[200px_1fr]',
    columnsCollapsed: 'grid-cols-[56px_1fr]',
    showSidebar: true,
    showEntries: false,
    mainPane: 'dashboard',
    showForm: false
  },
  {
    mode: 'writing',
    label: '专注写作',
    hint: '全屏编辑，隐藏侧栏与发布入口',
    columns: 'grid-cols-1',
    columnsCollapsed: 'grid-cols-1',
    showSidebar: false,
    showEntries: false,
    mainPane: 'editor',
    showForm: false
  },
  {
    mode: 'developer',
    label: '开发者',
    hint: 'Git 状态 / Diff / 发布 / 部署',
    columns: 'grid-cols-[200px_1fr]',
    columnsCollapsed: 'grid-cols-[56px_1fr]',
    showSidebar: true,
    showEntries: false,
    mainPane: 'publish',
    showForm: false
  }
]

export function metaOf(mode: ThemeMode): ThemeModeMeta {
  return THEME_MODE_META.find((item) => item.mode === mode) ?? THEME_MODE_META[0]
}

/** 明暗两档（与模式正交）：浅色 / 深色 */
export const COLOR_SCHEME_META: readonly { scheme: ColorScheme; label: string }[] = [
  { scheme: 'light', label: '浅色' },
  { scheme: 'dark', label: '深色' }
]

/**
 * 切换主题只改 `<html>` 上的 data 属性，由 CSS 变量层接管全部配色。
 * 刻意不做任何组件重挂载：编辑器（CodeMirror）的焦点与撤销栈必须保留。
 */
export function applyThemeMode(mode: ThemeMode): void {
  document.documentElement.dataset.mode = mode
}

export function applyColorScheme(scheme: ColorScheme): void {
  document.documentElement.dataset.scheme = scheme
}

/** 编辑区布局（与主题模式、明暗都正交）：单显编辑器 / 编辑+预览分栏 / 单显预览 */
export const EDITOR_LAYOUT_META: readonly { layout: EditorLayout; label: string; hint: string }[] = [
  { layout: 'editor', label: '编辑器', hint: '只显示 Markdown 源码' },
  { layout: 'split', label: '分栏', hint: '左侧源码 + 右侧实时预览' },
  { layout: 'preview', label: '预览', hint: '只显示消毒后的渲染结果' }
]

/** 内容分区 → CSS 变量引用（未登记的分区回落到 --muted） */
export function sectionColor(section: string): string {
  return `var(--sec-${section}, var(--muted))`
}