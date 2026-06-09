import React, { useEffect } from "react"
import type { WidgetProps } from "./FieldWidget.js"

function isEmptySelectValue(value: unknown): boolean {
  return value === null || value === undefined || value === ""
}

export function SelectWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const options = (config.options?.["values"] ?? []) as string[]
  const empty = isEmptySelectValue(value)
  const defaultOption = config.required && options.length > 0 ? options[0]! : ""
  const selectValue = empty ? defaultOption : String(value)

  // Required selects omit a blank option, but React still starts with value="".
  // Browsers display the first <option> while form state stays empty until onChange —
  // so Save can omit the column and Postgres raises NOT NULL.
  useEffect(() => {
    if (readOnly || !empty || !config.required || options.length === 0) return
    onChange(options[0])
  }, [readOnly, empty, config.required, options, onChange])

  return (
    <select
      id={`field-${config.name}`}
      className="st-select"
      value={selectValue}
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
