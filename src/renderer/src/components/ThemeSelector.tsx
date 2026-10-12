import { COLOR_SCHEME_META, metaOf, THEME_MODE_META } from '../theme'
import { useCms } from '../store'

/**
 * 主题面板：上半是 2×2 模式选择（带主题色圆点），下半是明暗切换。
 * 点一下 → 落盘 settings.json + 改 <html data-mode / data-scheme>，
 * 只换 CSS 变量取值，不触发任何组件重挂载（编辑器焦点与撤销栈必须保留）。
 * 布局用 Tailwind，颜色全部走 CSS 变量。
 */
export default function ThemeSelector() {
  const themeMode = useCms((state) => state.themeMode)
  const setThemeMode = useCms((state) => state.setThemeMode)
  const colorScheme = useCms((state) => state.colorScheme)
  const setColorScheme = useCms((state) => state.setColorScheme)

  return (
    <div className="flex flex-col gap-2" role="group" aria-label="主题与外观">
      <div className="grid grid-cols-2 gap-1.5">
        {THEME_MODE_META.map((item) => {
          const active = item.mode === themeMode
          return (
            <button
              key={item.mode}
              type="button"
              title={item.hint}
              aria-pressed={active}
              onClick={() => void setThemeMode(item.mode)}
              className={`flex items-center gap-1 rounded-[var(--radius)] border px-1.5 py-1.5 text-left text-[10px] leading-tight transition-colors ${
                active
                  ? 'border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border)] bg-[var(--card)] text-[var(--muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text)]'
              }`}
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: `var(--mode-${item.mode}-accent)` }}
              />
              <span className="truncate">{item.label}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {COLOR_SCHEME_META.map((item) => {
          const active = item.scheme === colorScheme
          return (
            <button
              key={item.scheme}
              type="button"
              aria-pressed={active}
              onClick={() => void setColorScheme(item.scheme)}
              className={`rounded-[var(--radius)] border px-2 py-1 text-[11px] transition-colors ${
                active
                  ? 'border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border)] bg-[var(--card)] text-[var(--muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text)]'
              }`}
            >
              {item.label}
            </button>
          )
        })}
      </div>

      <div className="text-[11px] leading-snug text-[var(--muted)]">{metaOf(themeMode).hint}</div>
    </div>
  )
}
