import { createContext, useContext, useState, useCallback, useEffect, useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import type React from "react"
import type { AdminConfig } from "../config.js"

const LOCALE_PARAM = "locale"

interface LocaleState {
  currentLocale: string
  setLocale: (locale: string) => void
  locales: Array<{ code: string; label: string }>
  defaultLocale: string
}

export const LocaleContext = createContext<LocaleState | null>(null)

export function useLocale(): LocaleState {
  const ctx = useContext(LocaleContext)
  if (!ctx) {
    throw new Error("useLocale must be used within a LocaleProvider")
  }
  return ctx
}

function resolveLocaleFromUrl(
  searchParams: URLSearchParams,
  validCodes: Set<string>,
  defaultLocale: string,
): string {
  const fromUrl = searchParams.get(LOCALE_PARAM)
  if (fromUrl && validCodes.has(fromUrl)) return fromUrl
  return defaultLocale
}

/**
 * Initialise locale state from a config object (passed directly to avoid
 * depending on AdminConfigContext, which isn't available yet when AdminApp
 * calls this hook before rendering the provider).
 *
 * Syncs the active locale with the `?locale=` URL query param for shareable editor links.
 */
export function useLocaleState(config: AdminConfig | null): LocaleState {
  const defaultLocale = config?.locale?.defaultLocale ?? "en"
  const locales = config?.locale?.locales ?? [{ code: "en", label: "English" }]
  const validCodes = useMemo(() => new Set(locales.map((l) => l.code)), [locales])
  const [searchParams, setSearchParams] = useSearchParams()

  const [currentLocale, setCurrentLocale] = useState(() =>
    resolveLocaleFromUrl(searchParams, validCodes, defaultLocale),
  )

  // Browser back/forward or external URL changes
  useEffect(() => {
    const next = resolveLocaleFromUrl(searchParams, validCodes, defaultLocale)
    setCurrentLocale((prev) => (prev === next ? prev : next))
  }, [searchParams, validCodes, defaultLocale])

  const setLocale = useCallback(
    (locale: string) => {
      if (!validCodes.has(locale)) return
      setCurrentLocale(locale)
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (locale === defaultLocale) {
            next.delete(LOCALE_PARAM)
          } else {
            next.set(LOCALE_PARAM, locale)
          }
          return next
        },
        { replace: true },
      )
    },
    [defaultLocale, setSearchParams, validCodes],
  )

  return {
    currentLocale,
    setLocale,
    locales,
    defaultLocale,
  }
}
