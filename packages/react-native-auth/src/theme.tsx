import React, { createContext, useContext } from "react"

export interface AuthThemeTokens {
  colorPrimary: string
  colorDanger: string
  colorText: string
  colorTextMuted: string
  colorBackground: string
  colorBorder: string
  colorSurface: string
  borderRadius: number
  spacing: number
  fontSize: number
  fontSizeTitle: number
}

export const defaultAuthTheme: AuthThemeTokens = {
  colorPrimary: "#0f766e",
  colorDanger: "#b91c1c",
  colorText: "#111827",
  colorTextMuted: "#6b7280",
  colorBackground: "#ffffff",
  colorBorder: "#d1d5db",
  colorSurface: "#f9fafb",
  borderRadius: 8,
  spacing: 16,
  fontSize: 14,
  fontSizeTitle: 20,
}

const AuthThemeContext = createContext<AuthThemeTokens>(defaultAuthTheme)

export interface AuthThemeProviderProps {
  tokens?: Partial<AuthThemeTokens> | undefined
  children: React.ReactNode
}

export function AuthThemeProvider({ tokens, children }: AuthThemeProviderProps): React.ReactElement {
  const value: AuthThemeTokens = { ...defaultAuthTheme, ...tokens }
  return React.createElement(AuthThemeContext.Provider, { value }, children)
}

export function useAuthTheme(): AuthThemeTokens {
  return useContext(AuthThemeContext)
}
