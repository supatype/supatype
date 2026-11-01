/**
 * Model hook deployment for a self-host stack.
 *
 *   POST /projects/:ref/hooks/deploy - the project's hook handlers and the manifest's maps
 *
 * `supatype push` to a linked self-host stack sends this after the schema is applied, with the body
 * it sends Cloud (`HookDeployBody`, @supatype/shared): `handlers`, each a name and its flattened
 * source, the generated adapter among them as `_supatype-hooks`; `map`, the hook map; and the
 * manifest's other two maps, `validators` (the functions a field's validator names travel with the
 * handlers) and `cache`.
 *
 * The stack's worker serves hooks from the project's hooks directory (SUPATYPE_HOOKS_ROOT), and the
 * server reads which hook or validator runs around a write, and what may be cached, from the
 * manifest. So each handler is written back into the layout a project keeps (`<name>/index.ts`,
 * importing `../_supatype/hooks.ts`), which on a stack run from the project's own checkout is the
 * file it already has, and the maps go into `.supatype/manifest.json` as a local push writes them.
 * Everything is checked before anything is written, and only what differs from the disk is written.
 *
 * The worker is restarted when what it loads differs from what it last loaded or a restart is owed,
 * and started when it has stopped (worker.ts); a cache-only change restarts nothing. A handler the
 * schema no longer names is left on disk: no map names it, so nothing calls it, and on that same
 * checkout it may be one being written.
 */
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname } from "node:path"
import {
  ADAPTER_NAME,
  applyManifestMaps,
  isCacheMap,
  isHookDeployBody,
  isHookMap,
  parseJsonObject,
  unflattenHookSource,
  type CacheMap,
  type HookMap,
} from "@supatype/shared"
import { badRequest, bodyOf, HttpError, route } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject } from "../project.js"
import { fileUnder, filesInDir, removeAll, sourcesNotKept, writeChanged, writeRoot, type DeployFile, type WriteRoot } from "../deploy-files.js"
import { answerWithWorkerCurrent, childDir, hooksRoot, manifestPath } from "../worker.js"

/** Where a project keeps the generated adapter under its hooks root. */
const ADAPTER_PATH = "_supatype/hooks.ts"

function checkedHookMap(map: unknown, key: "map" | "validators"): HookMap {
  if (!isHookMap(map)) throw badRequest(`${key} must be table to event or column to settings that name a function`)
  return map
}

/** The body's three maps, each checked; a map not sent is undefined and left as the manifest has it. */
function checkedMaps(body: { map?: unknown; validators?: unknown; cache?: unknown }): {
  hooks: HookMap
  validators: HookMap | undefined
  cache: CacheMap | undefined
} {
  const hooks = checkedHookMap(body.map ?? {}, "map")
  const validators = body.validators === undefined ? undefined : checkedHookMap(body.validators, "validators")
  if (body.cache !== undefined && !isCacheMap(body.cache)) throw badRequest("cache must be table to its settings: enabled, public, rows, maxTtl")
  return { hooks, validators, cache: body.cache }
}

/** The functions the maps call that were not uploaded, so a map never names a missing handler. */
function unresolved(names: ReadonlySet<string>, maps: ReadonlyArray<HookMap | undefined>): string[] {
  const missing = new Set<string>()
  for (const map of maps) {
    for (const entries of Object.values(map ?? {})) {
      for (const entry of Object.values(entries)) {
        if (!names.has(entry.function)) missing.add(entry.function)
      }
    }
  }
  return [...missing].sort()
}

/** The stack's manifest, which has to be there and be a JSON object before anything is written. */
function readManifest(): Record<string, unknown> {
  if (!existsSync(manifestPath())) {
    throw new HttpError(409, "conflict", "The stack has no .supatype/manifest.json; run `supatype self-host compose up` first")
  }
  const parsed = parseJsonObject(readFileSync(manifestPath(), "utf8"))
  if (!parsed.ok) throw new HttpError(409, "conflict", ".supatype/manifest.json is not a JSON object")
  return parsed.value
}

/**
 * Every file the deploy writes, all checked first (deploy-files.ts): one bad name, or one link on the
 * way out of the hooks directory, and none is written.
 */
function deployFiles(handlers: readonly SentHook[]): { files: DeployFile[]; names: string[]; stale: () => Promise<string[]> } {
  const root = writeRoot(hooksRoot(), "Hooks", { mayBeLink: true })
  const adapter = handlers.find((handler) => handler.name === ADAPTER_NAME)
  const named = handlers.filter((handler) => handler !== adapter)
  const names = named.map((handler) => basename(childDir(root.path, handler.name, "hook")))
  const files = named.flatMap((handler, i) => hookFiles(root, names[i]!, handler))
  if (adapter !== undefined) files.push(fileUnder(root, ADAPTER_PATH, adapter.source))
  // A hook sent as files is the whole of its directory: a source file an earlier deploy wrote there
  // and this one did not send would still be loaded.
  const stale = async () =>
    (
      await Promise.all(
        named.map((handler, i) => (handler.files === undefined ? [] : sourcesNotKept(root, names[i]!, keptPaths(handler.files)))),
      )
    ).flat()
  return { files, names: [...names].sort(), stale }
}

/** One handler as the body sends it. */
interface SentHook {
  name: unknown
  source: string
  files?: Record<string, string> | undefined
}

/** A hook's files: every one it sent, as written, or its one module, as the project keeps it. */
function hookFiles(root: WriteRoot, name: string, handler: SentHook): DeployFile[] {
  if (handler.files !== undefined) return filesInDir(root, name, handler.files)
  return [fileUnder(root, `${name}/index.ts`, unflattenHookSource(handler.source))]
}

/** The paths of `files` with `/` between their parts, as the walk for stale files names them. */
function keptPaths(files: Readonly<Record<string, string>>): Set<string> {
  return new Set(Object.keys(files).map((path) => path.split(/[\\/]/).join("/")))
}

/** The manifest as the file the deploy writes, checked like every other (deploy-files.ts). */
function manifestFile(manifest: Record<string, unknown>): DeployFile {
  const root = writeRoot(dirname(manifestPath()), "The stack's .supatype", { mayBeLink: true })
  return fileUnder(root, basename(manifestPath()), `${JSON.stringify(manifest, null, 2)}\n`)
}

export function registerHookRoutes(routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>): void {
  route(routes, "POST", "/projects/:ref/hooks/deploy", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = bodyOf(ctx.body, isHookDeployBody)
    const { files, names, stale } = deployFiles(body.handlers ?? [])
    const maps = checkedMaps(body)
    const missing = unresolved(new Set(names), [maps.hooks, maps.validators])
    if (missing.length > 0) throw badRequest(`The maps name functions that were not uploaded: ${missing.join(", ")}`)
    const manifest = readManifest()
    const changed = applyManifestMaps(manifest, maps)
    // Checked now, so a manifest that is a link fails the deploy before any handler is written.
    const manifestWrite = manifestFile(manifest)
    // Handlers before the maps, so a map never names a handler not yet on disk.
    await writeChanged(files)
    await removeAll(await stale())
    if (changed) await writeChanged([manifestWrite])
    // The worker is restarted when what it loads differs from what it last loaded (worker.ts); the
    // cache map is not part of that, since the server reads it and the worker does not.
    await answerWithWorkerCurrent(ctx.res, { handlers: names, tables: Object.keys(maps.hooks).sort() }, { sayRestarted: true })
  })
}
