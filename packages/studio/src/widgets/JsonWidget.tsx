import React, { useState, useCallback } from "react"
import { json } from "@codemirror/lang-json"
import type { WidgetProps } from "./FieldWidget.js"
import { FramedCodeEditor } from "./CodeMirrorEditor.js"
import { FieldError } from "./field-parts.js"

const jsonExtensions = [json()]

/** Typed JSON read: its value (null for nothing typed), or why it is not JSON. */
function readJson(text: string): { value: unknown } | { error: string } {
  if (text.trim() === "") return { value: null }
  try {
    const value: unknown = JSON.parse(text)
    return { value }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid JSON" }
  }
}

/** JSON edited as text, read when the editor leaves it; text that is not JSON is refused, not saved. */
export function JsonWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const [parseError, setParseError] = useState<string | null>(null)
  const initialText = value !== null && value !== undefined ? JSON.stringify(value, null, 2) : ""

  const handleBlur = useCallback((text: string) => {
    const read = readJson(text)
    if ("error" in read) {
      setParseError(read.error)
      return
    }
    setParseError(null)
    onChange(read.value)
  }, [onChange])

  return (
    <div className="flex flex-col">
      <FramedCodeEditor id={`field-${config.name}`} value={initialText} onBlur={handleBlur} readOnly={readOnly} extensions={jsonExtensions} />
      {parseError && <FieldError>{parseError}</FieldError>}
    </div>
  )
}
