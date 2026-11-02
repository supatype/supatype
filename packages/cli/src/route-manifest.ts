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
 * Every manifest key naming where the server reaches a service. Each one, when set, wins over the
 * server's own `SUPATYPE_*_URL` (`internal/proxy/manifest.go`), and the compose stack writes them
 * with its own service hostnames (`postgrest:3000`, `storage:5000`, `functions-worker:8001`).
 *
 * `app_upstream` and `vite_dev_url` are not here: they come from `app` in the config, the same
 * for either provider.
 */
const SERVICE_URL_KEYS = [
  "postgrest_url",
  "graphql_url",
  "storage_url",
  "realtime_url",
  "functions_worker_url",
  "function_worker_urls",
] as const

/**
 * Record native dev's routes in the manifest, whether or not the first push applied: no service
 * address from a compose stack, and functions on when there is a Deno to run them.
 *
 * Natively the server is handed every service's address in its environment, and a manifest key
 * overrides that. `init` writes the compose stack's manifest, and native dev dropped only the worker
 * URL, so every function answered 502 with "lookup functions-worker: no such host" (local test E),
 * and after that every REST call did with "lookup postgrest: no such host" (N2). Native realtime
 * records its own URL once it is running (native-realtime.ts). `functionsEnabled` is false when
 * there is no Deno, so the server says functions are disabled rather than proxying to nothing.
 */
export function recordNativeRoutes(manifestPath: string, functionsEnabled: boolean): void {
  // Undefined drops the key: JSON has no undefined.
  const dropped = Object.fromEntries(SERVICE_URL_KEYS.map((key) => [key, undefined]))
  patchRouteManifest(manifestPath, { ...dropped, functions_enabled: functionsEnabled })
}
