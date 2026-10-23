import React from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { Input } from "../components/ui.js"

/** A hex colour as it is typed: `#` and up to six hex digits, so a half-typed value is still accepted. */
const HEX_TYPING = /^#[0-9a-fA-F]{0,6}$/

/** A colour: the browser's picker, and the same value as hex text beside it. */
export function ColorWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const text = typeof value === "string" ? value : ""
  return (
    <div className="flex items-center gap-2">
      <Input id={`field-${config.name}`} type="color" className="h-10 w-10 shrink-0 cursor-pointer p-0.5" value={text || "#000000"} onChange={(e) => { onChange(e.target.value) }} disabled={readOnly} />
      <Input
        type="text"
        aria-label={`${config.label} hex value`}
        className="w-28 font-mono"
        value={text}
        onChange={(e) => { if (HEX_TYPING.test(e.target.value)) onChange(e.target.value) }}
        readOnly={readOnly}
        required={config.required}
        placeholder="#000000"
        maxLength={7}
        spellCheck={false}
      />
    </div>
  )
}
