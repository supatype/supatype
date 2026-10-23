import React from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { Input } from "../components/ui.js"
import { fromLocalInput, localZoneName, toLocalInput } from "../lib/local-datetime.js"

export function DateWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const isDatetime = config.widget === "datetime"
  const inputType = isDatetime ? "datetime-local" : "date"

  // A date-time is shown and typed in the editor's own zone, and saved with its offset. See
  // `local-datetime.ts` for why one form is right for columns with and without a zone.
  const forInput = (raw: unknown): string => (isDatetime ? toLocalInput(raw) : String(raw ?? "").slice(0, 10))

  // A temporal `Between` bounds the picker itself, so an out-of-range date is harder to pick than
  // to have rejected. The database enforces the same bound either way.
  const bound = (raw: number | string | undefined): string | undefined =>
    typeof raw === "string" ? forInput(raw) : undefined

  return (
    <Input
      id={`field-${config.name}`}
      type={inputType}
      min={bound(config.validation?.min)}
      max={bound(config.validation?.max)}
      value={forInput(value)}
      {...(isDatetime && { title: `Your local time (${localZoneName()})` })}
      onChange={(e) => {
        const v = e.target.value
        onChange(v === "" ? null : isDatetime ? fromLocalInput(v) : v)
      }}
      readOnly={readOnly}
      required={config.required}
    />
  )
}
