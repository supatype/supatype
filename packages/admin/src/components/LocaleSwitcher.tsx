import React from "react"
import { useLocale } from "../hooks/useLocale.js"

export function LocaleSwitcher(): React.ReactElement | null {
  const { currentLocale, setLocale, locales } = useLocale()

  if (locales.length <= 1) return null

  return (
    <div className="st-locale-switcher">
      <label htmlFor="st-locale-select" className="st-locale-label">
        Locale:
      </label>
      <select
        id="st-locale-select"
        value={currentLocale}
        onChange={(e) => { setLocale(e.target.value) }}
        className="st-locale-select"
      >
        {locales.map((loc) => (
          <option key={loc.code} value={loc.code}>
            {loc.label}
          </option>
        ))}
      </select>
    </div>
  )
}
