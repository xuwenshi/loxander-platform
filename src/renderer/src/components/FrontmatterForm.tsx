import { useEffect, useRef, useState } from 'react'
import type { CoverOption, FieldSpec, Issue, SectionSchema } from '../../../preload/api'
import type { Milestone } from '../formValue'

/**
 * schema 驱动的 frontmatter 表单：字段定义由主进程下发（单一来源），
 * renderer 只负责按 kind 渲染控件与回传值。
 */

interface Props {
  schema: SectionSchema
  fields: Record<string, unknown>
  issues: Issue[]
  onChange: (key: string, value: unknown) => void
  /** public/ 下的 .svg 候选，供 cover 字段下拉联想（仍允许自由输入） */
  covers?: CoverOption[]
}

/** 逗号分隔的字符串数组输入；保留输入中的原始文本，避免尾随逗号被吞掉 */
function ListInput({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const [text, setText] = useState(value.join(', '))
  const lastExternal = useRef(JSON.stringify(value))

  useEffect(() => {
    const external = JSON.stringify(value)
    if (external !== lastExternal.current) {
      lastExternal.current = external
      setText(value.join(', '))
    }
  }, [value])

  return (
    <input
      value={text}
      placeholder="逗号分隔"
      onChange={(event) => {
        const raw = event.target.value
        setText(raw)
        const items = raw
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '')
        lastExternal.current = JSON.stringify(items)
        onChange(items)
      }}
    />
  )
}

function MilestoneInput({ value, onChange }: { value: Milestone[]; onChange: (next: Milestone[]) => void }) {
  return (
    <div className="milestones">
      {value.map((item, index) => (
        <div className="milestone-row" key={index}>
          <input
            type="checkbox"
            checked={item.done}
            onChange={(event) => {
              const next = value.slice()
              next[index] = { ...item, done: event.target.checked }
              onChange(next)
            }}
          />
          <input
            value={item.title}
            placeholder="里程碑标题"
            onChange={(event) => {
              const next = value.slice()
              next[index] = { ...item, title: event.target.value }
              onChange(next)
            }}
          />
          <button
            type="button"
            className="ghost"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            移除
          </button>
        </div>
      ))}
      <button type="button" className="ghost" onClick={() => onChange([...value, { title: '', done: false }])}>
        + 添加里程碑
      </button>
    </div>
  )
}

function control(spec: FieldSpec, value: unknown, onChange: (next: unknown) => void, covers: CoverOption[] = []) {
  switch (spec.kind) {
    case 'boolean':
      return (
        <label className="checkbox">
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
          <span>{value === true ? '是' : '否'}</span>
        </label>
      )
    case 'enum':
      return (
        <select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
          <option value="">（未设置）</option>
          {spec.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )
    case 'number':
      return (
        <input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
        />
      )
    case 'date':
      return <input type="date" value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} />
    case 'stringArray':
      return <ListInput value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />
    case 'milestones':
      return (
        <MilestoneInput
          value={Array.isArray(value) ? (value as Milestone[]) : []}
          onChange={onChange}
        />
      )
    default:
      // cover 用 datalist 做候选联想：既可从 public/ 的 .svg 中选，也可自由输入
      return (
        <>
          <input
            list={spec.key === 'cover' && covers.length > 0 ? 'cms-cover-options' : undefined}
            value={String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
          />
          {spec.key === 'cover' && covers.length > 0 ? (
            <datalist id="cms-cover-options">
              {covers.map((item) => (
                <option key={item.path} value={item.path} />
              ))}
            </datalist>
          ) : null}
        </>
      )
  }
}

export default function FrontmatterForm({ schema, fields, issues, onChange, covers }: Props) {
  return (
    <div className="fm-form">
      {schema.fields.map((spec) => {
        const fieldIssues = issues.filter((issue) => issue.field === spec.key)
        return (
          <div className="fm-field" key={spec.key}>
            <div className="fm-label">
              <span className="fm-key">{spec.key}</span>
              <span className="fm-title">
                {spec.label}
                {spec.required ? <em className="req">必填</em> : null}
              </span>
            </div>
            {control(spec, fields[spec.key], (next) => onChange(spec.key, next), covers)}
            {spec.help ? <div className="fm-help">{spec.help}</div> : null}
            {fieldIssues.map((issue, index) => (
              <div key={index} className={issue.level === 'block' ? 'fm-issue err' : 'fm-issue warn'}>
                {issue.message}
                {issue.hint ? `（${issue.hint}）` : null}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}