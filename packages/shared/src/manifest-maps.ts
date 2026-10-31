/**
 * The route manifest's three maps (`hooks`, `validators`, `cache`), the hook deploy body that carries
 * them to a stack, and how a hook handler is flattened for that body and put back. The CLI writes the
 * maps for a local stack and sends the body to a linked one; the self-host control plane reads the
 * body and writes the same maps. Each kept its own copy of these until both drew them from here.
 */
import { isArrayOf, isBoolean, isNumber, isRecordOf, isShape, isString, isUnknown, optional, type FromShape } from "./json.js"

/** One hook or validator entry, in the shape the server's `proxy.RouteManifest` reads. */
export interface ManifestHookEntry {
  function: string
  timeout?: number
  onUnavailable?: "reject" | "log"
}

/** One table's cache declaration, as the manifest carries it. */
export interface ManifestCacheEntry {
  enabled?: boolean
  maxTtl?: number
  public?: boolean
  rows?: boolean
}

/** Table to event (hooks) or column (validators) to the entry. */
export type HookMap = Record<string, Record<string, ManifestHookEntry>>

/** Table to its cache declaration. */
export type CacheMap = Record<string, ManifestCacheEntry>

/** The manifest's three maps, keyed as the manifest keys them. */
export interface ManifestMaps {
  hooks: HookMap
  validators: HookMap
  cache: CacheMap
}

const isHookEntry = isShape({
  function: isString,
  timeout: optional(isNumber),
  onUnavailable: optional((value: unknown): value is "reject" | "log" => value === "reject" || value === "log"),
})

/** A hook or validator map: every entry names its function. */
export const isHookMap = isRecordOf(isRecordOf(isHookEntry))

/** A cache map: each entry carries only what the manifest reads, each of its type. */
export const isCacheMap = isRecordOf(
  isShape({ enabled: optional(isBoolean), public: optional(isBoolean), rows: optional(isBoolean), maxTtl: optional(isNumber) }),
)

const HOOK_DEPLOY_BODY = {
  handlers: optional(isArrayOf(isShape({ name: isUnknown, source: isString }))),
  map: optional(isUnknown),
  validators: optional(isUnknown),
  cache: optional(isUnknown),
} as const

/**
 * `POST /projects/:ref/hooks/deploy`: `handlers`, each a name and its flattened source, the adapter
 * among them as {@link ADAPTER_NAME}; `map`, the hook map; `validators` and `cache`, the manifest's
 * other two maps. The maps are checked with {@link isHookMap} and {@link isCacheMap} by the reader,
 * which says which is wrong.
 */
export const isHookDeployBody = isShape(HOOK_DEPLOY_BODY)
export type HookDeployBody = FromShape<typeof HOOK_DEPLOY_BODY>

/**
 * Sets each manifest key `maps` names to its map, removing the key when the map is empty; a key whose
 * map is undefined is left as it is. Removing rather than writing `{}` matters: the server tells "no
 * map" from "an empty map" when it decides whether the manifest predates the feature. True when the
 * manifest changed.
 */
export function applyManifestMaps(
  manifest: Record<string, unknown>,
  maps: { [K in keyof ManifestMaps]?: ManifestMaps[K] | undefined },
): boolean {
  let changed = false
  for (const [key, map] of Object.entries(maps)) {
    if (map === undefined) continue
    if (JSON.stringify(map) === JSON.stringify(manifest[key] ?? {})) continue
    if (Object.keys(map).length === 0) delete manifest[key]
    else manifest[key] = map
    changed = true
  }
  return changed
}

/** The generated adapter's name among the uploaded handlers; `_`-prefixed, so no worker routes to it. */
export const ADAPTER_NAME = "_supatype-hooks"

/** What a project's handler imports the adapter as, and what that import is flattened to. */
export const ADAPTER_IMPORT = "../_supatype/hooks.ts"
export const FLATTENED_ADAPTER_IMPORT = `./${ADAPTER_NAME}.ts`

/** A handler's source with its adapter import flattened, for a stack that serves handlers side by side. */
export function flattenHookSource(source: string): string {
  return source.split(ADAPTER_IMPORT).join(FLATTENED_ADAPTER_IMPORT)
}

/** A flattened handler's source put back into a project's layout (`<name>/index.ts`). */
export function unflattenHookSource(source: string): string {
  return source.split(FLATTENED_ADAPTER_IMPORT).join(ADAPTER_IMPORT)
}
