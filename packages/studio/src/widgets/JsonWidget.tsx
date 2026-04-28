import React, { useState, useCallback } from "react"
import { json } from "@codemirror/lang-json"
import type { WidgetProps } from "./FieldWidget.js"
import { CodeMirrorEditor } from "./CodeMirrorEditor.js"

const jsonExtensions = [json()]

export function JsonWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const [parseError, setParseError] = useState<string | null>(null)

  const initialText = value !== null && value !== undefined ? JSON.stringify(value, null, 2) : ""

  const handleBlur = useCallback(
    (text: string) => {
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
    },
    [onChange],
  )

  return (
    <div className="st-json-widget">
      <div className="st-json-editor rounded-md border border-border bg-background overflow-hidden">
        <CodeMirrorEditor
          id={`field-${config.name}`}
          value={initialText}
          onBlur={handleBlur}
          readOnly={readOnly}
          extensions={jsonExtensions}
          minHeight="180px"
        />
      </div>
      {parseError && (
        <p className="st-json-error" role="alert">
          {parseError}
        </p>
      )}
    </div>
  )
}
