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
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

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
