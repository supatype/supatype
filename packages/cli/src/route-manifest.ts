import { existsSync, writeFileSync } from "node:fs"
import { readJsonObjectFile } from "./json-file.js"

/** Merge fields into `.supatype/manifest.json` (creates file if missing). */
export function patchRouteManifest(
  manifestPath: string,
  patch: Record<string, unknown>,
): void {
  // Unreadable or not an object, the manifest starts again from the patch.
  const manifest = (existsSync(manifestPath) ? readJsonObjectFile(manifestPath) : undefined) ?? {}
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`, "utf8")
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
