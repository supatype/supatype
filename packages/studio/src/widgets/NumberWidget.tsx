import React from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { Input } from "../components/ui.js"
import { stringOption } from "./field-options.js"

/** A money amount: the number box between a display-only `$` and a note saying it is one. */
function MoneyFrame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-base text-muted-foreground" aria-hidden>$</span>
      {children}
      <span className="text-[0.7rem] text-muted-foreground">Stored as decimal; currency symbol is display-only</span>
    </div>
  )
}

export function NumberWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const isCurrency = Boolean(config.options?.["currency"])
  const input = (
    <Input
      id={`field-${config.name}`}
      type="number"
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(e) => { onChange(e.target.value === "" ? null : Number(e.target.value)) }}
      readOnly={readOnly}
      required={config.required}
      min={config.validation?.min}
      max={config.validation?.max}
      step={stringOption(config, "step") ?? (isCurrency ? "0.01" : undefined)}
    />
  )
  return isCurrency ? <MoneyFrame>{input}</MoneyFrame> : input
}
