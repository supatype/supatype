/**
 * Model hook deployment for a self-host stack.
 *
 *   POST /projects/:ref/hooks/deploy - the project's hook handlers and the manifest's maps
 *
 * `supatype push` to a linked self-host stack sends this after the schema is applied, with the body
 * it sends Cloud (`HookDeployBody`, @supatype/shared): `handlers`, each a name and its flattened
 * source, the generated adapter among them as `_supatype-hooks`; `map`, the hook map; and the
 * manifest's other maps, `validators` (the functions a field's validator names travel with the
 * handlers), `cache` and `tables` (each hooked table's after-hook columns and key).
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
import { basename, dirname, join } from "node:path"
import {
  ADAPTER_NAME,
  applyManifestMaps,
  FUNCTION_ENTRY_FILE,
  isCacheMap,
  isHookDeployBody,
  isHookMap,
  isTableMap,
  parseJsonObject,
  unflattenHookSource,
  type CacheMap,
  type HookDeployBody,
  type HookMap,
  type TableMap,
} from "@supatype/shared"
import { badRequest, bodyOf, HttpError, route } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject } from "../project.js"
import {
  fileUnder,
  filesInDir,
  keptPaths,
  removeAll,
  restoreFiles,
  snapshotFiles,
  sourcesNotKept,
  writeChanged,
  writeRoot,
  type DeployFile,
  type FileSnapshot,
  type WriteRoot,
} from "../deploy-files.js"
import { answerWithWorkerCurrent, childDir, hooksRoot, manifestPath } from "../worker.js"

/** Where a project keeps the generated adapter under its hooks root. */
const ADAPTER_PATH = "_supatype/hooks.ts"

function checkedHookMap(map: unknown, key: "map" | "validators"): HookMap {
  if (!isHookMap(map)) throw badRequest(`${key} must be table to event or column to settings that name a function`)
  return map
}

/** The body's maps, each checked; a map not sent is undefined and left as the manifest has it. */
function checkedMaps(body: Pick<HookDeployBody, "map" | "validators" | "cache" | "tables">): {
  hooks: HookMap
  validators: HookMap | undefined
  cache: CacheMap | undefined
  tables: TableMap | undefined
} {
  const hooks = checkedHookMap(body.map ?? {}, "map")
  const validators = body.validators === undefined ? undefined : checkedHookMap(body.validators, "validators")
  if (body.cache !== undefined && !isCacheMap(body.cache)) throw badRequest("cache must be table to its settings: enabled, public, rows, maxTtl")
  if (body.tables !== undefined && !isTableMap(body.tables)) {
    throw badRequest('tables must be table to its after-hook columns ("safe" or "all"), restrictedColumns and primaryKey')
  }
  return { hooks, validators, cache: body.cache, tables: body.tables }
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

/** One handler as the body sends it. */
interface SentHook {
  name: unknown
  source: string
  files?: Record<string, string> | undefined
}

/** One hook's files, checked, and the source files it no longer sends (its stale sweep). */
interface HookWrite {
  name: string
  files: DeployFile[]
  stale: () => Promise<string[]>
}

/** Why a hook was not deployed, said for the person who pushed it. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * A hook's files: every one it sent, as written, or its one module, as the project keeps it. Files
 * with no index.ts are refused: the hook would have no entry, and the sweep for files no longer sent
 * would remove the one it had.
 */
function hookWrite(root: WriteRoot, name: string, handler: SentHook): HookWrite {
  if (handler.files === undefined) {
    return { name, files: [fileUnder(root, `${name}/index.ts`, unflattenHookSource(handler.source))], stale: async () => [] }
  }
  const files = handler.files
  if (!keptPaths(files).has("index.ts")) throw badRequest(`Hook ${name}: its files have no index.ts, the module the worker runs`)
  return { name, files: filesInDir(root, name, files), stale: () => sourcesNotKept(root, name, keptPaths(files)) }
}

/** What a deploy does with the hooks it was sent: the writes it can make, and the hooks it refused. */
interface HookPlan {
  root: WriteRoot
  writes: HookWrite[]
  refused: Array<{ name: string; reason: string }>
  keep: string[]
  adapter: DeployFile | undefined
}

/**
 * Every hook's files, each checked on its own (deploy-files.ts): a bad path, a link on the way out of
 * the hooks directory or no index.ts refuses that hook only, and the others still deploy. A name
 * that is not one safe path segment refuses the request (400): it is not a hook that can be kept.
 */
function planHooks(handlers: readonly SentHook[], keep: readonly string[]): HookPlan {
  const root = writeRoot(hooksRoot(), "Hooks", { mayBeLink: true })
  const adapterSent = handlers.find((handler) => handler.name === ADAPTER_NAME)
  const named = handlers.filter((handler) => handler !== adapterSent)
  const names = named.map((handler) => basename(childDir(root.path, handler.name, "hook")))
  const kept = keep.map((name) => basename(childDir(root.path, name, "hook")))
  const both = names.filter((name) => kept.includes(name))
  if (both.length > 0) throw badRequest(`Sent and also to keep: ${both.join(", ")}`)
  const writes: HookWrite[] = []
  const refused: Array<{ name: string; reason: string }> = []
  named.forEach((handler, i) => {
    try {
      writes.push(hookWrite(root, names[i]!, handler))
    } catch (err) {
      refused.push({ name: names[i]!, reason: reasonOf(err) })
    }
  })
  const adapter = adapterSent === undefined ? undefined : fileUnder(root, ADAPTER_PATH, adapterSent.source)
  return { root, writes, refused, keep: kept, adapter }
}

/** A hook the deploy refused, and whether its previous files could not be put back (it is then broken). */
interface Refusal {
  name: string
  reason: string
  broken?: true
}

/**
 * Writes one hook, then sweeps the source files it no longer sends. When any of that fails, the hook
 * is refused and its files are put back as they were (restoreFiles), so "kept" is true; when they
 * cannot be, it is refused as broken, and the answer says locked.
 */
async function writeHook(root: WriteRoot, write: HookWrite): Promise<Refusal | undefined> {
  // Inside this hook's own try: a file that cannot be listed or read refuses this hook only, before
  // anything of it is written.
  let before: FileSnapshot
  let stale: string[]
  try {
    stale = await write.stale()
    before = await snapshotFiles([...write.files.map((file) => file.path), ...stale])
  } catch (err) {
    return { name: write.name, reason: reasonOf(err) }
  }
  try {
    await writeChanged(write.files)
    await removeAll(stale)
    return undefined
  } catch (err) {
    const reason = reasonOf(err)
    try {
      await restoreFiles(before, root)
      return { name: write.name, reason }
    } catch (restoreErr) {
      return { name: write.name, reason: `${reason}; its previous files could not be put back (${reasonOf(restoreErr)})`, broken: true }
    }
  }
}

/** Writes each hook, together; a hook whose write fails is refused, the others are written. */
async function writeHooks(root: WriteRoot, writes: readonly HookWrite[]): Promise<Refusal[]> {
  const outcomes = await Promise.all(writes.map((write) => writeHook(root, write)))
  return outcomes.filter((outcome): outcome is Refusal => outcome !== undefined)
}

/** Whether the worker has a route for the hook `name` on disk: `<name>/index.ts` or `<name>.ts`. */
function servedNow(root: WriteRoot, name: string): boolean {
  return existsSync(join(root.path, name, FUNCTION_ENTRY_FILE)) || existsSync(join(root.path, `${name}.ts`))
}

/**
 * The manifest as the file the deploy writes, checked like every other (deploy-files.ts), and written
 * whole: the worker and the server read it while a deploy may be rewriting it.
 */
function manifestFile(manifest: Record<string, unknown>): DeployFile {
  const root = writeRoot(dirname(manifestPath()), "The stack's .supatype", { mayBeLink: true })
  return { atomic: true, ...fileUnder(root, basename(manifestPath()), `${JSON.stringify(manifest, null, 2)}\n`) }
}

/**
 * The answer's data (HookDeployAnswer, @supatype/shared): the hooks deployed, and every hook not
 * deployed, sent to keep or refused here, as kept (its previous version still runs) or locked (it
 * had none, so writes to the tables that map it are refused until it deploys).
 */
function deployAnswer(plan: HookPlan, refused: readonly Refusal[], tables: string[]): Record<string, unknown> {
  const notDeployed = new Set([...plan.keep, ...refused.map((r) => r.name)])
  const deployed = plan.writes.map((write) => write.name).filter((name) => !notDeployed.has(name)).sort()
  // A hook whose files could not be put back is never "kept": what is on disk is not a version it had.
  const broken = new Set(refused.filter((r) => r.broken === true).map((r) => r.name))
  const isKept = (name: string): boolean => !broken.has(name) && servedNow(plan.root, name)
  const kept = [...notDeployed].filter(isKept).sort()
  const locked = [...notDeployed].filter((name) => !isKept(name)).sort()
  return {
    handlers: deployed,
    tables,
    ...(refused.length > 0 && { refused: refused.map(({ name, reason }) => ({ name, reason })).sort((a, b) => a.name.localeCompare(b.name)) }),
    ...(kept.length > 0 && { kept }),
    ...(locked.length > 0 && { locked }),
  }
}

export function registerHookRoutes(routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>): void {
  route(routes, "POST", "/projects/:ref/hooks/deploy", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = bodyOf(ctx.body, isHookDeployBody)
    const plan = planHooks(body.handlers ?? [], body.keep ?? [])
    const maps = checkedMaps(body)
    // A map may name a hook kept or refused: its tables then run the previous version, or refuse writes.
    const known = new Set([...plan.writes.map((write) => write.name), ...plan.refused.map((r) => r.name), ...plan.keep])
    const missing = unresolved(known, [maps.hooks, maps.validators])
    if (missing.length > 0) throw badRequest(`The maps name functions that were not uploaded: ${missing.join(", ")}`)
    const manifest = readManifest()
    const changed = applyManifestMaps(manifest, maps)
    // Checked now, so a manifest that is a link fails the deploy before any handler is written.
    const manifestWrite = manifestFile(manifest)
    if (plan.adapter !== undefined) await writeChanged([plan.adapter])
    // Handlers before the maps, so a map never names a handler not yet on disk.
    const refused = [...plan.refused, ...(await writeHooks(plan.root, plan.writes))]
    if (changed) await writeChanged([manifestWrite])
    // The worker is restarted when what it loads differs from what it last loaded (worker.ts); the
    // cache map is not part of that, since the server reads it and the worker does not.
    await answerWithWorkerCurrent(ctx.res, deployAnswer(plan, refused, Object.keys(maps.hooks).sort()), { sayRestarted: true })
  })
}
