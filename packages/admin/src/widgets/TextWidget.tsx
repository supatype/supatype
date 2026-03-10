import React from "react"
import type { WidgetProps } from "./FieldWidget.js"

interface TextWidgetProps extends WidgetProps {
  multiline?: boolean
}

export function TextWidget({ config, value, onChange, readOnly, multiline }: TextWidgetProps): React.ReactElement {
  const strValue = value === null || value === undefined ? "" : String(value)
  const maxLength = config.validation?.["maxLength"] as number | undefined

  if (multiline) {
    return (
      <div className="st-widget-text">
        <textarea
          id={`field-${config.name}`}
          className="st-textarea"
          value={strValue}
          onChange={(e) => { onChange(e.target.value || null) }}
          readOnly={readOnly}
          required={config.required}
          maxLength={maxLength}
          rows={6}
        />
        {maxLength && (
          <span className="st-char-count">
            {strValue.length} / {maxLength}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="st-widget-text">
      <input
        id={`field-${config.name}`}
        type={config.widget === "email" ? "email" : config.widget === "url" ? "url" : "text"}
        className="st-input"
        value={strValue}
        onChange={(e) => { onChange(e.target.value || null) }}
        readOnly={readOnly}
        required={config.required}
        maxLength={maxLength}
      />
      {maxLength && (
        <span className="st-char-count">
          {strValue.length} / {maxLength}
        </span>
      )}
    </div>
  )
}
