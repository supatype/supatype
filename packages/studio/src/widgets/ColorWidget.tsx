import React from "react"
import type { WidgetProps } from "./FieldWidget.js"

export function ColorWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const hex = typeof value === "string" && value ? value : "#000000"

  return (
    <div className="st-color-widget">
      <input
        id={`field-${config.name}`}
        type="color"
        className="st-color-swatch"
        value={hex}
        onChange={(e) => { onChange(e.target.value) }}
        disabled={readOnly}
      />
      <input
        type="text"
        className="st-input st-color-text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => {
          const v = e.target.value
          if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onChange(v)
        }}
        readOnly={readOnly}
        required={config.required}
        placeholder="#000000"
        maxLength={7}
        spellCheck={false}
      />
    </div>
  )
}
