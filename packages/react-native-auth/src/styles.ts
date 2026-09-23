import type { AuthThemeTokens } from "./theme.js"

export function fieldStyles(theme: AuthThemeTokens) {
  return {
    root: {
      backgroundColor: theme.colorBackground,
      padding: theme.spacing,
      gap: theme.spacing,
    },
    title: {
      color: theme.colorText,
      fontSize: theme.fontSizeTitle,
      fontWeight: "600" as const,
      marginBottom: theme.spacing / 2,
    },
    label: {
      color: theme.colorText,
      fontSize: theme.fontSize,
      marginBottom: 6,
      fontWeight: "500" as const,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.colorBorder,
      borderRadius: theme.borderRadius,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: theme.fontSize,
      color: theme.colorText,
      backgroundColor: theme.colorSurface,
      minHeight: 44,
    },
    error: {
      color: theme.colorDanger,
      fontSize: theme.fontSize,
      marginBottom: 4,
    },
    muted: {
      color: theme.colorTextMuted,
      fontSize: theme.fontSize,
    },
    button: {
      backgroundColor: theme.colorPrimary,
      borderRadius: theme.borderRadius,
      paddingVertical: 12,
      paddingHorizontal: 16,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      minHeight: 44,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    buttonText: {
      color: "#ffffff",
      fontSize: theme.fontSize,
      fontWeight: "600" as const,
    },
    secondaryButton: {
      backgroundColor: theme.colorSurface,
      borderWidth: 1,
      borderColor: theme.colorBorder,
      borderRadius: theme.borderRadius,
      paddingVertical: 12,
      paddingHorizontal: 16,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      minHeight: 44,
      flexDirection: "row" as const,
      gap: 8,
    },
    secondaryButtonText: {
      color: theme.colorText,
      fontSize: theme.fontSize,
      fontWeight: "500" as const,
    },
  }
}
