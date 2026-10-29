import { existsSync, writeFileSync } from "node:fs"
import { readJsonObjectFile } from "./json-file.js"

/** How {@link patchRouteManifest} treats a manifest it cannot read. */
export interface PatchRouteManifestOptions {
  /** Leave an unreadable or non-object manifest for the server to report, rather than start it again. */
  keepMalformed?: boolean
}

/**
 * Merge fields into `.supatype/manifest.json` (creates file if missing). An undefined field drops the
 * key: JSON has no undefined.
 *
 * Written only when a value changes. Every compose render and every native dev start patches it,
 * and rewrote it each time though nothing in it had changed.
 */
export function patchRouteManifest(
  manifestPath: string,
  patch: Record<string, unknown>,
  opts: PatchRouteManifestOptions = {},
): void {
  const exists = existsSync(manifestPath)
  const current = exists ? readJsonObjectFile(manifestPath) : undefined
  if (exists && current === undefined && opts.keepMalformed === true) return
  // Unreadable or not an object, the manifest starts again from the patch.
  const next = JSON.stringify({ ...current, ...patch }, null, 2)
  if (current !== undefined && next === JSON.stringify(current, null, 2)) return
  writeFileSync(manifestPath, `${next}\n`, "utf8")
}

/**
 * Record native dev's functions in the route manifest, whether or not the first push applied.
 *
 * Natively the server runs Deno itself and routes to it on its own `SUPATYPE_DENO_PORT` when the
 * manifest names no worker. `init` writes the compose stack's manifest, which names
 * `functions-worker:8001`, and native dev never replaced it, so every function answered 502 with
 * "lookup functions-worker: no such host". `enabled` is false when there is no Deno to run them,
 * so the server says functions are disabled rather than proxying to nothing.
 */
export function recordNativeFunctions(manifestPath: string, enabled: boolean): void {
  // Undefined drops the key: JSON has no undefined.
  patchRouteManifest(manifestPath, { functions_enabled: enabled, functions_worker_url: undefined })
}
