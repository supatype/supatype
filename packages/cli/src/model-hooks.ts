/**
 * Validate the lifecycle hooks a schema declares against the functions that exist.
 *
 * A hook names a function directory. If the name is wrong, the honest failure is at push time with
 * the path we searched, not at runtime, where the symptom is a hook that never fires and a write
 * that quietly succeeds unvalidated. That silence is the whole reason this check exists.
 *
 * Kept out of the extractor on purpose: resolving the functions directory needs the project config,
 * and the extractor is a leaf that reads type syntax and nothing else.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { generateHooksModule } from "./hooks-generator.js"
import { manifestCache } from "./model-cache.js"
import { astModels, objectAt } from "./ast-read.js"
import { readJsonObjectFile } from "./json-file.js"
import { isJsonObject, keptName } from "@supatype/shared"

export interface DeclaredHook {
  model: string
  event: string
  function: string
}

/** Every hook declared across the schema, in a stable order for reporting. */
export function declaredHooks(ast: unknown): DeclaredHook[] {
  return modelFunctions(ast, "hooks")
    .flatMap(({ model, entries }) => entries.map((entry) => ({ model, event: entry.key, function: entry.function })))
    .sort((a, b) => `${a.model}.${a.event}`.localeCompare(`${b.model}.${b.event}`))
}

/** One entry of a model's hook or validator map that names a function. */
interface FunctionEntry {
  /** The event (`beforeInsert`) or the field the entry is for. */
  key: string
  function: string
  value: Record<string, unknown>
}

/** A model's name and table, with the entries of one of its function maps. */
interface ModelFunctions {
  model: string
  table: unknown
  entries: FunctionEntry[]
}

/**
 * Per model, the entries of its `hooks` or `validate` map that name a function. Each step is
 * checked, so a malformed model or entry is skipped rather than throwing a TypeError out of
 * `supatype push`.
 */
function modelFunctions(ast: unknown, map: "hooks" | "validate"): ModelFunctions[] {
  const out: ModelFunctions[] = []
  for (const model of astModels(ast)) {
    const declared = objectAt(model, "annotations", "platform", map)
    if (declared === undefined) continue
    const entries: FunctionEntry[] = []
    for (const [key, value] of Object.entries(declared)) {
      if (!isJsonObject(value)) continue
      const fn = value["function"]
      if (typeof fn === "string" && fn.length > 0) entries.push({ key, function: fn, value })
    }
    const name = model["name"]
    // As Postgres keeps it: the worker looks hooks up by the table a write lands in.
    const table = objectAt(model, "annotations", "db")?.["tableName"]
    out.push({ model: typeof name === "string" ? name : "?", table: typeof table === "string" ? keptName(table) : table, entries })
  }
  return out
}

/** Each table's entries as manifest entries, leaving out tables with no name or no entries. */
function manifestMap(
  ast: unknown,
  map: "hooks" | "validate",
  toEntry: (entry: FunctionEntry) => ManifestHookEntry,
): Record<string, Record<string, ManifestHookEntry>> {
  const out: Record<string, Record<string, ManifestHookEntry>> = {}
  for (const { table, entries } of modelFunctions(ast, map)) {
    if (typeof table !== "string" || table.length === 0 || entries.length === 0) continue
    out[table] = Object.fromEntries(entries.map((entry) => [entry.key, toEntry(entry)]))
  }
  return out
}

/** An entry's own `timeout`, or the default. */
function timeoutOf(entry: FunctionEntry): number {
  const timeout = entry.value["timeout"]
  return typeof timeout === "number" ? timeout : DEFAULT_HOOK_TIMEOUT_MS
}

/** Function directory names available to be used as hooks. */
function availableFunctions(hooksDir: string): string[] {
  if (!existsSync(hooksDir)) return []
  return readdirSync(hooksDir)
    .filter((entry) => !entry.startsWith("_") && !entry.startsWith("."))
    .filter((entry) => {
      const full = join(hooksDir, entry)
      // A function is a directory with an index.ts, matching how the worker discovers them.
      return statSync(full).isDirectory() && existsSync(join(full, "index.ts"))
    })
    .sort()
}

/**
 * Lines describing every hook whose function is missing, empty when all resolve.
 *
 * Returns the message rather than throwing so the caller decides how to fail: `push` stops, while
 * `doctor` can report several problems at once.
 */
export function validateModelHooks(
  ast: unknown,
  hooksDir: string,
  cwd: string,
): string[] {
  const hooks = declaredHooks(ast)
  if (hooks.length === 0) return []

  const available = availableFunctions(hooksDir)
  const known = new Set(available)
  const missing = hooks.filter((hook) => !known.has(hook.function))
  if (missing.length === 0) return []

  const where = relative(cwd, hooksDir) || hooksDir
  const lines = missing.map(
    (hook) => `  ${hook.model}.${hook.event} → "${hook.function}" (no ${where}/${hook.function}/index.ts)`,
  )
  lines.push("")
  lines.push(
    available.length > 0
      ? `Hooks found in ${where}: ${available.join(", ")}`
      : `No hooks found in ${where}. Create one with: supatype hooks new <name>`,
  )
  return lines
}

/**
 * Write `hooks/_supatype/hooks.ts`, under the project's hooks directory (`hooksPathFromProject`),
 * or remove a stale one when no hooks remain.
 *
 * Removal matters as much as writing: deleting the last hook from a schema should leave no typed
 * module behind claiming tables are hooked, and a handler importing it should start failing to
 * compile rather than sitting there dead.
 *
 * Returns the project-relative path written, or null when there was nothing to write.
 */
export function writeHooksModule(cwd: string, hooksDir: string, ast: unknown): string | null {
  const module = generateHooksModule(ast)
  const dir = join(hooksDir, "_supatype")
  const file = join(dir, "hooks.ts")

  if (module === null) {
    if (existsSync(file)) rmSync(file, { force: true })
    return null
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(file, module, "utf8")
  return relative(cwd, file) || file
}

/** Per-table hook config, in the shape `proxy.RouteManifest` reads. */
export interface ManifestHookEntry {
  function: string
  timeout?: number
  onUnavailable?: "reject" | "log"
}

/**
 * The hook map for `.supatype/manifest.json`, keyed by **table name**, because that is what the
 * server matches a request path against, not the model name.
 *
 * Defaults are resolved here rather than in the server: one place decides that a `before*` hook
 * rejects when it cannot be reached and an `after*` hook only logs, so the two implementations
 * cannot disagree about the safe direction.
 */
export function manifestHooks(ast: unknown): Record<string, Record<string, ManifestHookEntry>> {
  return manifestMap(ast, "hooks", (entry) => {
    const declared = entry.value["onUnavailable"]
    const onUnavailable =
      declared === "reject" || declared === "log" ? declared : entry.key.startsWith("before") ? "reject" : "log"
    return { function: entry.function, timeout: timeoutOf(entry), onUnavailable }
  })
}


/** One declared per-field validator. `event` is the field it checks, so reporting reads uniformly. */
export interface DeclaredValidator {
  model: string
  field: string
  function: string
}

/** Every per-field validator declared across the schema, in a stable order for reporting. */
export function declaredValidators(ast: unknown): DeclaredValidator[] {
  return modelFunctions(ast, "validate")
    .flatMap(({ model, entries }) => entries.map((entry) => ({ model, field: entry.key, function: entry.function })))
    .sort((a, b) => `${a.model}.${a.field}`.localeCompare(`${b.model}.${b.field}`))
}

/**
 * The validator map for `.supatype/manifest.json`, keyed by **table** then **column**.
 *
 * `onUnavailable` is written explicitly as `reject` rather than left to the server's default. The
 * server does default that way, but its policy matches exact event names, and a validator that
 * silently accepted a value because a new event name was missing from a switch is precisely the
 * failure found when that path was built. Saying it here means neither side has to be right alone.
 */
export function manifestValidators(ast: unknown): Record<string, Record<string, ManifestHookEntry>> {
  return manifestMap(ast, "validate", (entry) => ({
    function: entry.function,
    timeout: timeoutOf(entry),
    onUnavailable: "reject",
  }))
}

/**
 * Validators naming a function that does not exist, as lines for a push failure.
 *
 * Shares `availableFunctions` with the hook check, so "what counts as a function" cannot come to
 * mean two things.
 */
export function validateModelValidators(
  ast: unknown,
  hooksDir: string,
  cwd: string,
): string[] {
  const validators = declaredValidators(ast)
  if (validators.length === 0) return []

  const available = availableFunctions(hooksDir)
  const known = new Set(available)
  const missing = validators.filter((entry) => !known.has(entry.function))
  if (missing.length === 0) return []

  const where = relative(cwd, hooksDir) || hooksDir
  const lines = missing.map(
    (entry) =>
      `  ${entry.model}.${entry.field} → "${entry.function}" (no ${where}/${entry.function}/index.ts)`,
  )
  lines.push("")
  lines.push(
    available.length > 0
      ? `Functions found in ${where}: ${available.join(", ")}`
      : `No functions found in ${where}. Create one with: supatype hooks new <name>`,
  )
  return lines
}

/** Well below the 10s edge-function ceiling, so a hung hook fails fast instead of holding a slot. */
export const DEFAULT_HOOK_TIMEOUT_MS = 2000

/**
 * Merge the hook and validator maps into an existing `.supatype/manifest.json`.
 *
 * Both keys are written here rather than in two functions, because they fail together and for the
 * same reason: each is a map the server reads to decide what to call around a write, and a manifest
 * carrying a stale one calls the wrong thing or nothing at all. A validator that is never called is
 * the worse half of that: the schema says the field is checked, and no error appears anywhere,
 * because the write simply succeeds.
 *
 * `cache` is here for a third reason of the same kind: the declaration is a ceiling the server
 * enforces, and a manifest carrying a stale one lets a table be cached that the schema has since
 * stopped permitting, or stops one the schema now allows, which is merely slow rather than wrong.
 * The first of those is why it is written at push and not left to drift.
 *
 * **Only updates a manifest that is already there.** Creating one from scratch here would be a
 * hazard: `functions_enabled` is a plain bool on the server's side, so a manifest carrying only
 * hooks would read as functions *disabled*, the exact defect this repo fixed a commit ago, arriving
 * by a different door. The compose path owns creation; this owns two keys.
 *
 * Returns true when the file was rewritten.
 */
export function syncManifestHooks(cwd: string, ast: unknown): boolean {
  const manifestPath = join(cwd, ".supatype", "manifest.json")
  if (!existsSync(manifestPath)) return false

  // Malformed: the server will complain about it far more clearly than we can here.
  const parsed = readJsonObjectFile(manifestPath)
  if (parsed === undefined) return false

  const changedHooks = applyManifestMap(parsed, "hooks", manifestHooks(ast))
  const changedValidators = applyManifestMap(parsed, "validators", manifestValidators(ast))
  const changedCache = applyManifestMap(parsed, "cache", manifestCache(ast))
  if (!changedHooks && !changedValidators && !changedCache) return false

  writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  return true
}

/**
 * Set one manifest key to `map`, or remove it when the schema declares none.
 *
 * Removing rather than writing `{}` matters: the server distinguishes "no map" from "an empty map"
 * when it decides whether the manifest predates the feature, and an empty object left behind by a
 * schema that no longer declares any is not the same statement.
 */
/**
 * `Record<string, unknown>` rather than a hook map: this never looks inside a value, it compares
 * the serialised form and swaps it. It was typed to hooks only because hooks were the first caller,
 * and that narrowness is what a third key would otherwise have had to work around.
 */
function applyManifestMap(
  manifest: Record<string, unknown>,
  key: string,
  map: Record<string, unknown>,
): boolean {
  const next = JSON.stringify(map)
  if (next === JSON.stringify(manifest[key] ?? {})) return false

  if (Object.keys(map).length === 0) {
    delete manifest[key]
  } else {
    manifest[key] = map
  }
  return true
}

export interface HooksReport {
  declared: DeclaredHook[]
  /** Hooks whose function directory is missing. */
  missing: DeclaredHook[]
  /** True when a manifest exists and says the functions subsystem is off. */
  functionsDisabled: boolean
  /** True when a manifest exists but carries no hook map, so the server has nothing to call. */
  mapMissing: boolean
  /** Field validators declared across the schema. */
  validators: DeclaredValidator[]
  /**
   * Validators whose function directory is missing.
   *
   * Reported apart from `missing` because the consequence is different and worth saying plainly: a
   * missing hook is a lifecycle step that will not run, a missing validator is a field written
   * unchecked.
   */
  validatorsMissing: DeclaredValidator[]
  /** True when validators are declared and the manifest carries no validator map. */
  validatorMapMissing: boolean
}

/**
 * What `supatype doctor` needs to answer "will my hooks actually run?".
 *
 * Local facts only: the schema, the functions on disk, and the manifest the server reads. No probe
 * of a running worker, so the answer is the same whether or not the stack is up, and a report that
 * needs a stack is a report nobody runs before deploying.
 *
 * The case worth catching: hooks declared while `functions_enabled` is false. Nothing fails, no error
 * appears, and every hook silently never fires.
 */
export function hooksReport(cwd: string, hooksDir: string, ast: unknown): HooksReport {
  const declared = declaredHooks(ast)
  const validators = declaredValidators(ast)
  const manifestPath = join(cwd, ".supatype", "manifest.json")

  let functionsDisabled = false
  let mapMissing = false
  let validatorMapMissing = false
  if ((declared.length > 0 || validators.length > 0) && existsSync(manifestPath)) {
    // Unparseable: the server reports that far better than a doctor line could.
    const parsed = readJsonObjectFile(manifestPath)
    if (parsed !== undefined) {
      functionsDisabled = parsed["functions_enabled"] === false
      mapMissing = declared.length > 0 && parsed["hooks"] === undefined
      validatorMapMissing = validators.length > 0 && parsed["validators"] === undefined
    }
  }

  const known = new Set(
    existsSync(hooksDir)
      ? readdirSync(hooksDir).filter(
          (entry) =>
            !entry.startsWith("_") &&
            !entry.startsWith(".") &&
            statSync(join(hooksDir, entry)).isDirectory() &&
            existsSync(join(hooksDir, entry, "index.ts")),
        )
      : [],
  )

  return {
    declared,
    missing: declared.filter((hook) => !known.has(hook.function)),
    functionsDisabled,
    mapMissing,
    validators,
    validatorsMissing: validators.filter((entry) => !known.has(entry.function)),
    validatorMapMissing,
  }
}
