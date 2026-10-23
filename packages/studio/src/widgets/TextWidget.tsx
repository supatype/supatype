import React from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { Input, Textarea } from "../components/ui.js"
import { CharCount } from "./field-parts.js"

interface TextWidgetProps extends WidgetProps {
  multiline?: boolean
}

function inputType(widget: string): "email" | "url" | "text" {
  return widget === "email" ? "email" : widget === "url" ? "url" : "text"
}

export function TextWidget({ config, value, onChange, readOnly, multiline, localePlaceholder }: TextWidgetProps): React.ReactElement {
  const strValue = value === null || value === undefined ? "" : String(value)
  const maxLength = config.validation?.maxLength
  const shared = {
    id: `field-${config.name}`,
    value: strValue,
    readOnly,
    required: config.required,
    maxLength,
    minLength: config.validation?.minLength,
    placeholder: localePlaceholder,
  }

  return (
    <div>
      {multiline ? (
        <Textarea face="prose" className="min-h-[100px] resize-y" rows={6} {...shared} onChange={(e) => { onChange(e.target.value || null) }} />
      ) : (
        <Input type={inputType(config.widget)} {...shared} onChange={(e) => { onChange(e.target.value || null) }} />
      )}
      {maxLength !== undefined && <CharCount length={strValue.length} max={maxLength} />}
    </div>
  )
}
