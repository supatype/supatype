/**
 * Model hook deployment for a self-host stack.
 *
 *   POST /projects/:ref/hooks/deploy - the project's hook handlers and its hook map
 *
 * `supatype push` to a linked self-host stack sends this after the schema is applied, with the body
 * it sends Cloud: `handlers`, each a name and its source, flattened (packages/cli/src/hook-upload.ts),
 * with the generated adapter as `_supatype-hooks`, and `map`, table to event to the hook's settings.
 * The control plane did not have the route, so that push applied its schema and ended `Route not
 * found` (local test round 4, N23).
 *
 * The stack's worker serves hooks from the project's hooks directory (SUPATYPE_HOOKS_ROOT), and the
 * server reads which hook runs around a write from the manifest's `hooks` key. So each handler is
 * written back into the layout a project keeps (`<name>/index.ts`, importing `../_supatype/hooks.ts`),
 * which on a stack run from the project's own checkout is the file it already has. A handler the
 * schema no longer names is left on disk: the map no longer names it either, so nothing calls it,
 * and on that same checkout it may be a hook still being written. Everything is checked before
 * anything is written; the handlers go before the map, so a map never names a handler not yet there.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { FUNCTION_NAME_RULE, isArrayOf, isFunctionName, isJsonObject, isRecordOf, isShape, isString, isUnknown, optional } from "@supatype/shared"
import { badRequest, bodyOf, HttpError, route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject, projectRoot } from "../project.js"
import { restartFunctionsWorker } from "./functions.js"

/** The generated adapter's name in the upload, and where a project keeps it under the hooks root. */
const ADAPTER_NAME = "_supatype-hooks"
const ADAPTER_PATH = join("_supatype", "hooks.ts")

/** The import the CLI flattened a handler's adapter import to, and the one a project's handler makes. */
const FLATTENED_IMPORT = `./${ADAPTER_NAME}.ts`
const PROJECT_IMPORT = "../_supatype/hooks.ts"

const isDeployBody = isShape({
  handlers: optional(isArrayOf(isShape({ name: isUnknown, source: isString }))),
  map: optional(isUnknown),
})

/** One file to write, already checked: its path under the hooks root and its contents. */
interface HookFile {
  path: string
  source: string
}

function hooksRoot(): string {
  return process.env["SUPATYPE_HOOKS_ROOT"] ?? join(projectRoot(), "hooks")
}

function manifestPath(): string {
  return join(projectRoot(), ".supatype", "manifest.json")
}

/**
 * Where handler `name` goes: refused unless it passes the function-name rule the CLI checks and
 * resolves to a direct child of the hooks root. The second check backs up the first.
 */
function handlerFile(name: unknown, source: string): HookFile {
  if (!isFunctionName(name)) throw badRequest(`Invalid hook name ${JSON.stringify(name)}: ${FUNCTION_NAME_RULE}`)
  const root = resolve(hooksRoot())
  const dir = resolve(root, name)
  if (dirname(dir) !== root) throw badRequest(`Hook name ${JSON.stringify(name)} resolves outside the hooks directory`)
  return { path: join(dir, "index.ts"), source: source.split(FLATTENED_IMPORT).join(PROJECT_IMPORT) }
}

/** The map as the manifest carries it: table to event to settings naming a `function`; other settings pass as sent. */
const isHookMap = isRecordOf(isRecordOf(isShape({ function: isString })))
type HookMap = typeof isHookMap extends (value: unknown) => value is infer T ? T : never

function checkedMap(map: unknown): HookMap {
  const value = map ?? {}
  if (!isHookMap(value)) throw badRequest("map must be table to event to settings that name a function")
  return value
}

/** The handler names the map calls that were not uploaded, so a map never names a missing handler. */
function unresolved(names: ReadonlySet<string>, map: HookMap): string[] {
  const missing = new Set<string>()
  for (const events of Object.values(map)) {
    for (const entry of Object.values(events)) {
      if (!names.has(entry.function)) missing.add(entry.function)
    }
  }
  return [...missing].sort()
}

/** The stack's manifest, which has to be there and be an object before anything is written. */
function readManifest(): Record<string, unknown> {
  if (!existsSync(manifestPath())) {
    throw new HttpError(409, "conflict", "The stack has no .supatype/manifest.json; run `supatype self-host compose up` first")
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath(), "utf8"))
  if (!isJsonObject(manifest)) throw new HttpError(409, "conflict", ".supatype/manifest.json is not a JSON object")
  return manifest
}

/** Sets the manifest's `hooks` key to `map`, or removes it when there is none, as the CLI writes it. */
function writeHookMap(manifest: Record<string, unknown>, map: HookMap): void {
  if (Object.keys(map).length === 0) delete manifest["hooks"]
  else manifest["hooks"] = map
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

/** Every file the deploy writes, all checked first: one bad name and none is written. */
function deployFiles(handlers: ReadonlyArray<{ name: unknown; source: string }>): { files: HookFile[]; names: string[] } {
  const adapter = handlers.find((handler) => handler.name === ADAPTER_NAME)
  const named = handlers.filter((handler) => handler !== adapter)
  const files = named.map((handler) => handlerFile(handler.name, handler.source))
  if (adapter !== undefined) files.push({ path: join(resolve(hooksRoot()), ADAPTER_PATH), source: adapter.source })
  return { files, names: named.map((handler) => String(handler.name)).sort() }
}

export function registerHookRoutes(routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>): void {
  route(routes, "POST", "/projects/:ref/hooks/deploy", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = bodyOf(ctx.body, isDeployBody)
    const { files, names } = deployFiles(body.handlers ?? [])
    const map = checkedMap(body.map)
    const missing = unresolved(new Set(names), map)
    if (missing.length > 0) throw badRequest(`The hook map names handlers that were not uploaded: ${missing.join(", ")}`)
    const manifest = readManifest()
    for (const file of files) {
      mkdirSync(dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.source, "utf8")
    }
    writeHookMap(manifest, map)
    restartFunctionsWorker()
    sendJson(ctx.res, 200, { data: { handlers: names, tables: Object.keys(map).sort() } })
  })
}
