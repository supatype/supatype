import React from "react"
import type { WidgetProps } from "./FieldWidget.js"

export function BooleanWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  return (
    <label className="st-toggle">
      <input
        id={`field-${config.name}`}
        type="checkbox"
        className="st-toggle-input"
        checked={!!value}
        onChange={(e) => { onChange(e.target.checked) }}
        disabled={readOnly}
      />
      <span className="st-toggle-slider" />
      <span className="st-toggle-label">{value ? "Yes" : "No"}</span>
    </label>
  )
}
