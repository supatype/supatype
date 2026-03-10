import React from "react"
import type { WidgetProps } from "./FieldWidget.js"

export function SelectWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const options = (config.options?.["values"] ?? []) as string[]

  return (
    <select
      id={`field-${config.name}`}
      className="st-select"
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(e) => { onChange(e.target.value || null) }}
      disabled={readOnly}
      required={config.required}
    >
      {!config.required && <option value="">— Select —</option>}
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  )
}
