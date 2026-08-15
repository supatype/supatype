import React from "react"
import type { WidgetProps } from "./FieldWidget.js"

/**
 * Editor for a `Currency<Code>` field — `{ amount, code }` stored as JSONB, where `amount` is a
 * string of **minor units** (1050 is £10.50) and `code` is the ISO currency.
 *
 * The input edits minor units, because that is what the row holds and what arithmetic elsewhere will
 * use. Dividing by 100 to show a friendlier number would be wrong for the currencies that do not
 * have two decimal places — JPY has none, KWD has three — so the human-readable figure is a
 * **read-only preview** produced by `Intl.NumberFormat`, which knows each currency's exponent.
 */
interface CurrencyValue {
  amount?: string
  code?: string
}

function asCurrencyValue(value: unknown): CurrencyValue {
  return typeof value === "object" && value !== null ? (value as CurrencyValue) : {}
}

/** Minor units → a formatted major-unit string, or null when it cannot be done faithfully. */
function formatMinorUnits(amount: string, code: string): string | null {
  if (amount.trim() === "" || code.trim() === "") return null
  if (!/^-?\d+$/.test(amount.trim())) return null
  try {
    const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency: code })
    const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2
    return formatter.format(Number(amount) / 10 ** exponent)
  } catch {
    // An unknown currency code: say nothing rather than guess at two decimal places.
    return null
  }
}

export function CurrencyWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const current = asCurrencyValue(value)
  const amount = typeof current.amount === "string" ? current.amount : ""
  const code = typeof current.code === "string" ? current.code : ""
  const preview = formatMinorUnits(amount, code)

  return (
    <div className="st-currency-widget flex flex-col gap-1">
      <div className="flex gap-2">
        <input
          id={`field-${config.name}`}
          className="st-input flex-1 rounded-md border border-border bg-background px-3 py-2"
          value={amount}
          inputMode="numeric"
          placeholder="minor units, e.g. 1050"
          readOnly={readOnly}
          onChange={(e) => onChange?.({ ...current, amount: e.target.value } as never)}
        />
        <input
          className="st-input w-24 rounded-md border border-border bg-background px-3 py-2 uppercase"
          value={code}
          placeholder="GBP"
          maxLength={3}
          readOnly={readOnly}
          onChange={(e) => onChange?.({ ...current, code: e.target.value.toUpperCase() } as never)}
        />
      </div>
      <p className="st-field-hint text-xs text-muted-foreground">
        {preview !== null ? `${preview} — stored as ${amount} minor units` : "Amount in minor units"}
      </p>
    </div>
  )
}
