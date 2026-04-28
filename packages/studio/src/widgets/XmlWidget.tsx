import React from "react"
import { xml } from "@codemirror/lang-xml"
import type { WidgetProps } from "./FieldWidget.js"
import { CodeMirrorEditor } from "./CodeMirrorEditor.js"

const xmlExtensions = [xml()]

export function XmlWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const text = typeof value === "string" ? value : ""

  return (
    <div className="st-json-widget">
      <div className="st-json-editor rounded-md border border-border bg-background overflow-hidden">
        <CodeMirrorEditor
          id={`field-${config.name}`}
          value={text}
          onChange={onChange as (v: string) => void}
          readOnly={readOnly}
          extensions={xmlExtensions}
          minHeight="180px"
        />
      </div>
    </div>
  )
}
