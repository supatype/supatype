import React from "react"
import type { WidgetProps } from "./FieldWidget.js"

export function DateWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const isDatetime = config.widget === "datetime"
  const inputType = isDatetime ? "datetime-local" : "date"

  let inputValue = ""
  if (value !== null && value !== undefined) {
    const str = String(value)
    if (isDatetime) {
      inputValue = str.slice(0, 16)
    } else {
      inputValue = str.slice(0, 10)
    }
  }

  return (
    <input
      id={`field-${config.name}`}
      type={inputType}
      className="st-input"
      value={inputValue}
      onChange={(e) => {
        const v = e.target.value
        onChange(v === "" ? null : isDatetime ? new Date(v).toISOString() : v)
      }}
      readOnly={readOnly}
      required={config.required}
    />
  )
}
