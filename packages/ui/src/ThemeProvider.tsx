import React, { createContext, useContext, useEffect, useState } from "react"

type Theme = "light" | "dark" | "system"

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: "light" | "dark"
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider")
  return ctx
}

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "dark"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export const ThemeProvider: React.FC<{ defaultTheme?: Theme; children: React.ReactNode }> = ({
  defaultTheme = "system",
  children,
}) => {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") return defaultTheme
    return (localStorage.getItem("supatype-theme") as Theme) ?? defaultTheme
  })
  const [resolvedTheme, setResolved] = useState<"light" | "dark">(() =>
    theme === "system" ? getSystemTheme() : theme,
  )

  useEffect(() => {
    const resolved = theme === "system" ? getSystemTheme() : theme
    setResolved(resolved)
    document.documentElement.classList.toggle("dark", resolved === "dark")
  }, [theme])

  useEffect(() => {
    if (theme !== "system") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = () => {
      const resolved = getSystemTheme()
      setResolved(resolved)
      document.documentElement.classList.toggle("dark", resolved === "dark")
    }
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [theme])

  const setTheme = (t: Theme) => {
    setThemeState(t)
    localStorage.setItem("supatype-theme", t)
  }

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
