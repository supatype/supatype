import React, { useState } from "react"
import type { WidgetProps } from "./FieldWidget.js"

export function JsonWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const [text, setText] = useState(() =>
    value !== null && value !== undefined ? JSON.stringify(value, null, 2) : "",
  )
  const [parseError, setParseError] = useState<string | null>(null)

  const handleBlur = () => {
    if (text.trim() === "") {
      setParseError(null)
      onChange(null)
      return
    }
    try {
      const parsed = JSON.parse(text) as unknown
      setParseError(null)
      onChange(parsed)
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON")
    }
  }

  return (
    <div className="st-json-widget">
      <textarea
        id={`field-${config.name}`}
        className={`st-json-editor${parseError ? " st-json-editor--error" : ""}`}
        value={text}
        onChange={(e) => { setText(e.target.value) }}
        onBlur={handleBlur}
        readOnly={readOnly}
        required={config.required}
        rows={10}
        spellCheck={false}
      />
      {parseError && <p className="st-json-error" role="alert">{parseError}</p>}
    </div>
  )
}
