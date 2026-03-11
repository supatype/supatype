import React from "react"
import type { WidgetProps } from "./FieldWidget.js"

export function NumberWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const min = config.validation?.["min"] as number | undefined
  const max = config.validation?.["max"] as number | undefined

  return (
    <input
      id={`field-${config.name}`}
      type="number"
      className="st-input"
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(e) => {
        const v = e.target.value
        onChange(v === "" ? null : Number(v))
      }}
      readOnly={readOnly}
      required={config.required}
      min={min}
      max={max}
    />
  )
}
