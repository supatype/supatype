import React from "react"
import { xml } from "@codemirror/lang-xml"
import type { WidgetProps } from "./FieldWidget.js"
import { FramedCodeEditor } from "./CodeMirrorEditor.js"

const xmlExtensions = [xml()]

export function XmlWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const text = typeof value === "string" ? value : ""
  return <FramedCodeEditor id={`field-${config.name}`} value={text} onChange={onChange} readOnly={readOnly} extensions={xmlExtensions} />
}
