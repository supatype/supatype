import React from "react"
import { useLocale } from "../hooks/useLocale.js"
import { Select } from "./ui.js"

/**
 * The header's content-locale picker, on the shared Select.
 *
 * It was styled by bespoke `st-locale-*` rules, one of which stretched it to the full width of the
 * header below 768px and pushed everything after it, the account menu included, off the screen.
 * Below `sm` the "Locale:" label is read out but not shown.
 */
export function LocaleSwitcher(): React.ReactElement | null {
  const { currentLocale, setLocale, locales } = useLocale()

  if (locales.length <= 1) return null

  return (
    <div className="flex shrink-0 items-center gap-2">
      <label htmlFor="st-locale-select" className="sr-only sm:not-sr-only text-[0.8rem] text-muted-foreground">
        Locale:
      </label>
      <Select
        id="st-locale-select"
        value={currentLocale}
        onChange={(e) => { setLocale(e.target.value) }}
        className="px-2 py-[0.3rem] text-xs bg-secondary rounded"
      >
        {locales.map((loc) => (
          <option key={loc.code} value={loc.code}>
            {loc.label}
          </option>
        ))}
      </Select>
    </div>
  )
}
