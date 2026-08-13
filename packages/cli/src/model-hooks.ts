/**
 * Validate the lifecycle hooks a schema declares against the functions that exist.
 *
 * A hook names a function directory. If the name is wrong, the honest failure is at push time with
 * the path we searched — not at runtime, where the symptom is a hook that never fires and a write
 * that quietly succeeds unvalidated. That silence is the whole reason this check exists.
 *
 * Kept out of the extractor on purpose: resolving the functions directory needs the project config,
 * and the extractor is a leaf that reads type syntax and nothing else.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { generateHooksModule } from "./hooks-generator.js"

export interface DeclaredHook {
  model: string
  event: string
  function: string
}

/** Every hook declared across the schema, in a stable order for reporting. */
export function declaredHooks(ast: unknown): DeclaredHook[] {
  const models = (ast as { models?: unknown[] })?.models
  if (!Array.isArray(models)) return []

  const out: DeclaredHook[] = []
  for (const model of models) {
    const shaped = model as {
      name?: string
      annotations?: { platform?: { hooks?: Record<string, unknown> } }
    }
    const hooks = shaped.annotations?.platform?.hooks
    if (typeof hooks !== "object" || hooks === null) continue

    for (const [event, value] of Object.entries(hooks)) {
      const fn = (value as { function?: unknown })?.function
      if (typeof fn === "string" && fn.length > 0) {
        out.push({ model: shaped.name ?? "?", event, function: fn })
      }
    }
  }
  return out.sort((a, b) => `${a.model}.${a.event}`.localeCompare(`${b.model}.${b.event}`))
}

/** Function directory names available to be used as hooks. */
function availableFunctions(functionsDir: string): string[] {
  if (!existsSync(functionsDir)) return []
  return readdirSync(functionsDir)
    .filter((entry) => !entry.startsWith("_") && !entry.startsWith("."))
    .filter((entry) => {
      const full = join(functionsDir, entry)
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
  functionsDir: string,
  cwd: string,
): string[] {
  const hooks = declaredHooks(ast)
  if (hooks.length === 0) return []

  const available = availableFunctions(functionsDir)
  const known = new Set(available)
  const missing = hooks.filter((hook) => !known.has(hook.function))
  if (missing.length === 0) return []

  const where = relative(cwd, functionsDir) || functionsDir
  const lines = missing.map(
    (hook) => `  ${hook.model}.${hook.event} → "${hook.function}" (no ${where}/${hook.function}/index.ts)`,
  )
  lines.push("")
  lines.push(
    available.length > 0
      ? `Functions found in ${where}: ${available.join(", ")}`
      : `No functions found in ${where}. Create one with: supatype functions new <name>`,
  )
  return lines
}

/**
 * Write `functions/_supatype/hooks.ts`, or remove a stale one when no hooks remain.
 *
 * Removal matters as much as writing: deleting the last hook from a schema should leave no typed
 * module behind claiming tables are hooked, and a handler importing it should start failing to
 * compile rather than sitting there dead.
 *
 * Returns the project-relative path written, or null when there was nothing to write.
 */
export function writeHooksModule(cwd: string, functionsDir: string, ast: unknown): string | null {
  const module = generateHooksModule(ast)
  const dir = join(functionsDir, "_supatype")
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
 * The hook map for `.supatype/manifest.json`, keyed by **table name** — because that is what the
 * server matches a request path against, not the model name.
 *
 * Defaults are resolved here rather than in the server: one place decides that a `before*` hook
 * rejects when it cannot be reached and an `after*` hook only logs, so the two implementations
 * cannot disagree about the safe direction.
 */
export function manifestHooks(ast: unknown): Record<string, Record<string, ManifestHookEntry>> {
  const models = (ast as { models?: unknown[] })?.models
  if (!Array.isArray(models)) return {}

  const out: Record<string, Record<string, ManifestHookEntry>> = {}
  for (const model of models) {
    const shaped = model as {
      annotations?: {
        db?: { tableName?: string }
        platform?: { hooks?: Record<string, { function?: string; timeout?: number; onUnavailable?: string }> }
      }
    }
    const table = shaped.annotations?.db?.tableName
    const hooks = shaped.annotations?.platform?.hooks
    if (typeof table !== "string" || table.length === 0) continue
    if (typeof hooks !== "object" || hooks === null) continue

    const entries: Record<string, ManifestHookEntry> = {}
    for (const [event, value] of Object.entries(hooks)) {
      const fn = value?.function
      if (typeof fn !== "string" || fn.length === 0) continue
      const onUnavailable =
        value.onUnavailable === "reject" || value.onUnavailable === "log"
          ? value.onUnavailable
          : event.startsWith("before")
            ? "reject"
            : "log"
      entries[event] = {
        function: fn,
        timeout: typeof value.timeout === "number" ? value.timeout : DEFAULT_HOOK_TIMEOUT_MS,
        onUnavailable,
      }
    }
    if (Object.keys(entries).length > 0) out[table] = entries
  }
  return out
}

/** Well below the 10s edge-function ceiling, so a hung hook fails fast instead of holding a slot. */
export const DEFAULT_HOOK_TIMEOUT_MS = 2000

/**
 * Merge the hook map into an existing `.supatype/manifest.json`.
 *
 * **Only updates a manifest that is already there.** Creating one from scratch here would be a
 * hazard: `functions_enabled` is a plain bool on the server's side, so a manifest carrying only
 * hooks would read as functions *disabled* — the exact defect this repo fixed a commit ago, arriving
 * by a different door. The compose path owns creation; this owns one key.
 *
 * Returns true when the file was rewritten.
 */
export function syncManifestHooks(cwd: string, ast: unknown): boolean {
  const manifestPath = join(cwd, ".supatype", "manifest.json")
  if (!existsSync(manifestPath)) return false

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  } catch {
    return false // Malformed: the server will complain about it far more clearly than we can here.
  }
  if (typeof parsed !== "object" || parsed === null) return false

  const hooks = manifestHooks(ast)
  const next = JSON.stringify(hooks)
  const current = JSON.stringify(parsed["hooks"] ?? {})
  if (next === current) return false

  if (Object.keys(hooks).length === 0) {
    delete parsed["hooks"]
  } else {
    parsed["hooks"] = hooks
  }
  writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
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
}

/**
 * What `supatype doctor` needs to answer "will my hooks actually run?".
 *
 * Local facts only — the schema, the functions on disk, and the manifest the server reads. No probe
 * of a running worker, so the answer is the same whether or not the stack is up, and a report that
 * needs a stack is a report nobody runs before deploying.
 *
 * The case worth catching: hooks declared while `functions_enabled` is false. Nothing fails, no error
 * appears, and every hook silently never fires.
 */
export function hooksReport(cwd: string, functionsDir: string, ast: unknown): HooksReport {
  const declared = declaredHooks(ast)
  const manifestPath = join(cwd, ".supatype", "manifest.json")

  let functionsDisabled = false
  let mapMissing = false
  if (declared.length > 0 && existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
      functionsDisabled = parsed["functions_enabled"] === false
      mapMissing = parsed["hooks"] === undefined
    } catch {
      // Unparseable: the server reports that far better than a doctor line could.
    }
  }

  const known = new Set(
    existsSync(functionsDir)
      ? readdirSync(functionsDir).filter(
          (entry) =>
            !entry.startsWith("_") &&
            !entry.startsWith(".") &&
            statSync(join(functionsDir, entry)).isDirectory() &&
            existsSync(join(functionsDir, entry, "index.ts")),
        )
      : [],
  )

  return {
    declared,
    missing: declared.filter((hook) => !known.has(hook.function)),
    functionsDisabled,
    mapMissing,
  }
}
