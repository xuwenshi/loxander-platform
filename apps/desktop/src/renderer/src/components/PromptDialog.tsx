import { useEffect, useRef, useState } from 'react'

export interface PromptField {
  key: string
  label: string
  placeholder?: string
  defaultValue?: string
}

/**
 * 应用内输入弹窗：替代 `window.prompt`。
 * Electron **没有实现 `window.prompt`**（实测调用即抛错 `prompt() is not supported.`），
 * 导致依赖它取值的「新建 / 重命名」在点击后直接中断、毫无反应。
 * 这里用普通 DOM 弹窗实现同样的交互。
 */
export default function PromptDialog({
  title,
  confirmText = '确定',
  fields,
  onCancel,
  onConfirm
}: {
  title: string
  confirmText?: string
  fields: PromptField[]
  onCancel: () => void
  onConfirm: (values: Record<string, string>) => void
}) {
  const first = fields[0]
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.defaultValue ?? '']))
  )
  const firstRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    firstRef.current?.focus()
    firstRef.current?.select()
    // 仅在弹窗挂载时聚焦首个输入框
  }, [])

  const disabled = !(values[first.key] ?? '').trim()
  const submit = (): void => {
    if (disabled) return
    onConfirm(values)
  }

  return (
    <div className="dialog-mask" onMouseDown={onCancel}>
      <div className="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        {fields.map((field, index) => (
          <label key={field.key} className="dialog-field">
            <span>{field.label}</span>
            <input
              ref={index === 0 ? firstRef : undefined}
              type="text"
              value={values[field.key] ?? ''}
              placeholder={field.placeholder}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
                if (event.key === 'Escape') onCancel()
              }}
            />
          </label>
        ))}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="primary" onClick={submit} disabled={disabled}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}