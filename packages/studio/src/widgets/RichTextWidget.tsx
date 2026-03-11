import React from "react"
import type { WidgetProps } from "./FieldWidget.js"

export function RichTextWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const content = typeof value === "string"
    ? value
    : value !== null && value !== undefined
      ? JSON.stringify(value, null, 2)
      : ""

  return (
    <div className="st-richtext-widget">
      <textarea
        id={`field-${config.name}`}
        className="st-richtext-editor"
        value={content}
        onChange={(e) => {
          const text = e.target.value
          try {
            onChange(JSON.parse(text))
          } catch {
            onChange(text)
          }
        }}
        readOnly={readOnly}
        required={config.required}
        rows={12}
        placeholder="Rich text content (Lexical JSON)..."
      />
      <p className="st-richtext-note">
        Full Lexical editor integration loads when @lexical/react is available.
      </p>
    </div>
  )
}
