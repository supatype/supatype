import type { LivePreviewConfig } from "../config.js"

/**
 * Where this record is rendered, given the project's preview configuration.
 *
 * `urlPattern` names fields in braces (`/blog/{slug}`) and they come from the values in hand, so a
 * record being edited previews at the address its *current* slug implies rather than the one it had
 * when it loaded. Falls back to the bare `url` when no pattern is stated, which is the right answer
 * for a single-page preview.
 *
 * Shared by the two things that need it and would otherwise each grow their own: the live preview
 * iframe, which shows unsaved keystrokes, and a shared preview link, which shows a saved draft to
 * someone with no account. Two different mechanisms answering two different questions, but the same
 * address.
 */
export function previewUrlFor(
  config: LivePreviewConfig,
  values: Record<string, unknown>,
): string {
  if (config.urlPattern === undefined || config.urlPattern === "") return config.url
  return config.urlPattern.replace(/\{(\w+)\}/g, (_, field: string) =>
    encodeURIComponent(String(values[field] ?? "")),
  )
}
