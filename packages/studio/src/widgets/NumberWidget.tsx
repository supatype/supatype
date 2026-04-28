import React from "react"
import type { WidgetProps } from "./FieldWidget.js"

export function NumberWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const min = config.validation?.["min"] as number | undefined
  const max = config.validation?.["max"] as number | undefined
  const isCurrency = Boolean(config.options?.["currency"])
  const step = (config.options?.["step"] as string | undefined) ?? (isCurrency ? "0.01" : undefined)

  const input = (
    <input
      id={`field-${config.name}`}
      type="number"
      className="st-input"
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(e) => {
        const v = e.target.value
        onChange(v === "" ? null : Number(v))
      }}
      readOnly={readOnly}
      required={config.required}
      min={min}
      max={max}
      step={step}
    />
  )

  if (isCurrency) {
    return (
      <div className="st-money-widget">
        <span className="st-money-symbol" aria-hidden>$</span>
        {input}
        <span className="st-money-hint">Stored as decimal; currency symbol is display-only</span>
      </div>
    )
  }

  return input
}
