/**
 * Shared ANSI styling for Supatype CLI output and the dev TUI.
 */

export const RESET = "\x1b[0m"
export const DIM = "\x1b[2m"
export const BOLD = "\x1b[1m"
export const BRAND_COLOR = "\x1b[35m"

export function brandStyle(text: string): string {
  return `${BRAND_COLOR}${BOLD}${text}${RESET}`
}
