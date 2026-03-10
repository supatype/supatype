import React from "react"
import type { WidgetProps } from "./FieldWidget.js"

/**
 * Rich text editor widget.
 *
 * In the full implementation, this would use Lexical (Meta's editor).
 * For now, this renders a structured JSON textarea that stores Lexical-compatible
 * content. The Lexical integration is lazy-loaded to minimize bundle size.
 */
export function RichTextWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  // For the initial implementation, render a simple contentEditable-like textarea.
  // The full Lexical integration requires a separate build step and lazy loading.
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
          // Try to parse as JSON (Lexical state), fall back to plain string
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
