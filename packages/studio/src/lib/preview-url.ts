import type { LivePreviewConfig } from "../config.js"

/**
 * Where this record is rendered, given the project's preview configuration and where Studio itself
 * is served from.
 *
 * `urlPattern` names fields in braces (`/blog/{slug}`) and they come from the values in hand, so a
 * record being edited previews at the address its *current* slug implies rather than the one it had
 * when it loaded. Falls back to the bare `url` when no pattern is stated, which is the right answer
 * for a single-page preview.
 *
 * # Why a path is enough
 *
 * With `app.mode` set to `static` or `proxy`, the deployment serves the project's own app at `/` on
 * the same origin as the API, so the origin is something Studio was handed rather than something a
 * project should have to state. Writing it out again is retyping what we already know, and it goes
 * stale the moment the deployment moves.
 *
 * So a pattern may be a path, resolved here against the origin Studio is actually loaded against.
 * An absolute URL still wins, which is what `app.mode: "none"` needs: the app is somewhere else
 * entirely and no deployment fact can say where.
 *
 * Resolved at render rather than baked in at push, deliberately. The origin a project pushes from
 * is not necessarily the origin Studio is later served from, and a value written into
 * `admin-config.json` would be wrong for whichever of the two came second.
 *
 * Shared by the two things that need it and would otherwise each grow their own: the live preview
 * iframe, which shows unsaved keystrokes, and a shared preview link, which shows a saved draft to
 * someone with no account. Two different mechanisms answering two different questions, but the same
 * address.
 *
 * Returns an empty string when the project has said nothing at all, which is what the share control
 * reads as "not configured" and answers by naming the setting.
 */
export function previewUrlFor(
  config: LivePreviewConfig,
  values: Record<string, unknown>,
  origin?: string | undefined,
): string {
  const pattern = [config.urlPattern, config.url].find((v) => v !== undefined && v !== "")
  if (pattern === undefined) return ""

  const filled = pattern.replace(/\{(\w+)\}/g, (_, field: string) =>
    encodeURIComponent(String(values[field] ?? "")),
  )
  return resolveAgainst(filled, origin)
}

function resolveAgainst(address: string, origin?: string | undefined): string {
  if (origin === undefined || origin === "") return address
  // An address that names its own origin is used as given. The optional scheme covers the
  // protocol-relative form, `//example.com/x`, which already names a host.
  //
  // Kept deliberately in step with `namesAnOrigin` in the CLI's preview-config-check.ts: that one
  // decides which addresses a push refuses, this one decides what those addresses render as, and a
  // disagreement between them passes both test suites while breaking the link.
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(address)) return address
  return `${origin.replace(/\/+$/, "")}/${address.replace(/^\/+/, "")}`
}
