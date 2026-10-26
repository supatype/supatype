import React from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { Switch } from "../components/ui.js"

export function BooleanWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-2">
      <Switch id={`field-${config.name}`} label={config.label} checked={!!value} onChange={onChange} disabled={readOnly} />
      <span className="text-xs text-muted-foreground">{value ? "Yes" : "No"}</span>
    </span>
  )
}
