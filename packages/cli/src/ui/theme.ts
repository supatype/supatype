/**
 * Supatype terminal design tokens — shared by Ink components and plain CI output.
 */

export const RESET = "\x1b[0m"
export const DIM = "\x1b[2m"
export const BOLD = "\x1b[1m"

export const theme = {
  brand: "magenta" as const,
  brandHex: "#c084fc",
  info: "cyan" as const,
  warn: "yellow" as const,
  error: "red" as const,
  success: "green" as const,
  dim: "gray" as const,
  muted: "gray" as const,
} as const

/** Legacy ANSI exports used by dev-logo / dev-task-colors. */
export const BRAND_COLOR = "\x1b[35m"

export function brandStyle(text: string): string {
  return `${BRAND_COLOR}${BOLD}${text}${RESET}`
}

export function plainInfo(message: string): string {
  return `${theme.info === "cyan" ? "\x1b[36m" : ""}ℹ ${message}${RESET}`
}

export function plainWarn(message: string): string {
  return `\x1b[33m⚠ ${message}${RESET}`
}

export function plainError(message: string): string {
  return `\x1b[31m✗ ${message}${RESET}`
}

export function plainSuccess(message: string): string {
  return `\x1b[32m✓ ${message}${RESET}`
}
