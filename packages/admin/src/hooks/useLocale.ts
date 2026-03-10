import { createContext, useContext, useState, useCallback } from "react"
import type React from "react"
import { useAdminConfig } from "./useAdminConfig.js"

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

export function useLocaleState(): LocaleState {
  const config = useAdminConfig()
  const defaultLocale = config.locale?.defaultLocale ?? "en"
  const [currentLocale, setCurrentLocale] = useState(defaultLocale)

  const setLocale = useCallback((locale: string) => {
    setCurrentLocale(locale)
  }, [])

  return {
    currentLocale,
    setLocale,
    locales: config.locale?.locales ?? [{ code: "en", label: "English" }],
    defaultLocale,
  }
}
