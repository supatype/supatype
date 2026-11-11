import { existsSync, writeFileSync } from "node:fs"
import { isJsonObject } from "@supatype/shared"
import { readJsonObjectFile } from "./json-file.js"

/**
 * How the route manifest switches one service on or off, as the server reads it (ServiceSwitch in
 * the server's internal/proxy/service_switch.go). Every service's entry is this, and any settings a
 * service gains extend it. `enabled` absent says nothing: the server's start value stands (storage
 * on unless SUPATYPE_STORAGE_DISABLED, functions on when a worker is configured, realtime off).
 */
export interface ServiceSwitch {
  enabled?: boolean
}

/** The services the manifest switches, by their key in its `services` map. */
export type SwitchableService = "realtime" | "storage" | "functions"

const SWITCHABLE_SERVICES: readonly SwitchableService[] = ["realtime", "storage", "functions"]

/** On, off, or undefined to say nothing, for each service to switch. */
export type ServiceSwitches = Partial<Record<SwitchableService, boolean | undefined>>

/**
 * The keys that switched a service before `services` (realtime and functions; storage never had
 * one released). The server still reads them, Cloud and older CLIs write them, and a `services`
 * entry wins, so each is dropped when its service is switched, and the file says it once.
 */
const LEGACY_SWITCH_KEYS: Partial<Record<SwitchableService, string>> = {
  realtime: "realtime_enabled",
  functions: "functions_enabled",
}

/** The manifest's `services` map, one entry per service, or empty when it has none it can read. */
function servicesOf(manifest: Record<string, unknown> | undefined): Record<string, unknown> {
  const services = manifest?.["services"]
  return isJsonObject(services) ? { ...services } : {}
}

/**
 * The patch that applies `switches` over `current`: its `services` map with each switch set (or its
 * `enabled` dropped, for undefined), the rest of each entry kept, and each switched service's legacy
 * key dropped. One rule for every service and every writer (0.9.2): realtime, storage and functions
 * were each switched by a key of their own, written by a rule of their own.
 */
export function serviceSwitchPatch(current: Record<string, unknown> | undefined, switches: ServiceSwitches): Record<string, unknown> {
  const services = servicesOf(current)
  const patch: Record<string, unknown> = {}
  for (const name of SWITCHABLE_SERVICES) {
    if (!(name in switches)) continue
    const enabled = switches[name]
    const { enabled: _previous, ...rest } = isJsonObject(services[name]) ? services[name] : {}
    const entry: ServiceSwitch & Record<string, unknown> = { ...rest, ...(enabled !== undefined && { enabled }) }
    if (Object.keys(entry).length > 0) services[name] = entry
    else delete services[name]
    const legacy = LEGACY_SWITCH_KEYS[name]
    if (legacy !== undefined) patch[legacy] = undefined
  }
  patch["services"] = Object.keys(services).length > 0 ? services : undefined
  return patch
}

/** Switch services on or off in the manifest, with `patch` (their URLs, say) in the same write. */
export function switchServices(
  manifestPath: string,
  switches: ServiceSwitches,
  patch: Record<string, unknown> = {},
  opts: PatchRouteManifestOptions = {},
): void {
  const current = existsSync(manifestPath) ? readJsonObjectFile(manifestPath) : undefined
  patchRouteManifest(manifestPath, { ...patch, ...serviceSwitchPatch(current, switches) }, opts)
}

/** What the manifest says of a service: its `services` entry, else its legacy key, else nothing. */
export function serviceSwitch(manifest: Record<string, unknown>, name: SwitchableService): boolean | undefined {
  const entry = servicesOf(manifest)[name]
  if (isJsonObject(entry) && typeof entry["enabled"] === "boolean") return entry["enabled"]
  const legacy = LEGACY_SWITCH_KEYS[name]
  const value = legacy === undefined ? undefined : manifest[legacy]
  return typeof value === "boolean" ? value : undefined
}

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
  // Undefined drops the key: JSON has no undefined. The storage switch too: native storage sets it
  // again as it starts, and one left from an earlier run would switch off a storage service of the
  // developer's own (SUPATYPE_STORAGE_URL), which native dev does not start.
  const dropped = Object.fromEntries(SERVICE_URL_KEYS.map((key) => [key, undefined]))
  switchServices(manifestPath, { functions: functionsEnabled, storage: undefined }, dropped)
}
