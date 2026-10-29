/**
 * The functions a project's functions directory holds, found the way the functions worker finds
 * them (`{name}/index.ts` folders and `{name}.ts` files, skipping `_shared` and dotfiles), and
 * checked against the name rule the control plane enforces.
 */
import { basename, join } from "node:path"
import { existsSync, readdirSync, statSync } from "node:fs"
import { FUNCTION_NAME_RULE, isFunctionName } from "@supatype/shared"
import { fatalError } from "./ui/fatal.js"

export interface DiscoveredFunctionRoute {
  name: string
  entrypoint: string
  /** The `{name}/` folder, or the `{name}.ts` file. */
  path: string
}

/**
 * A function the control plane would refuse by its name. Named here, where the folder is found,
 * so `dev`, `functions serve` and `functions deploy` say so before anything runs or is sent.
 */
export class InvalidFunctionNameError extends Error {
  override readonly name = "InvalidFunctionNameError"
}

/**
 * Why `name` is not a function name, or undefined when it is one. `entry` is what holds it in the
 * functions directory (`sendEmail/`, `Webhook.ts`).
 */
export function functionNameProblem(name: string, entry: string = name): string | undefined {
  if (isFunctionName(name)) return undefined
  const suggestion = suggestedFunctionName(name)
  const example = suggestion === undefined ? "" : ` (for example "${suggestion}")`
  return `"${entry}" is not a valid function name: ${FUNCTION_NAME_RULE}${example}.`
}

/** `sendEmail` as `send-email`: what a name the rule refuses most likely meant, if anything. */
function suggestedFunctionName(name: string): string | undefined {
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
  return isFunctionName(kebab) ? kebab : undefined
}

/** The function `entry` in `functionsDir` holds, or undefined for anything that is not one. */
function functionAt(functionsDir: string, entry: string): DiscoveredFunctionRoute | undefined {
  if (entry.startsWith("_") || entry.startsWith(".")) return undefined
  const fullPath = join(functionsDir, entry)
  if (statSync(fullPath).isDirectory()) {
    const indexTs = join(fullPath, "index.ts")
    return existsSync(indexTs) ? { name: entry, entrypoint: indexTs, path: fullPath } : undefined
  }
  if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) return undefined
  return { name: basename(entry, ".ts"), entrypoint: fullPath, path: fullPath }
}

/**
 * The handlers in `dir` as the worker finds them: `{name}/index.ts` dirs and `*.ts` files, skipping
 * `_shared` and dotfiles, sorted by name. Names are not checked: model hooks are not functions.
 */
export function discoverHandlersInDir(dir: string): DiscoveredFunctionRoute[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((entry) => functionAt(dir, entry))
    .filter((fn): fn is DiscoveredFunctionRoute => fn !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * {@link discoverHandlersInDir} for public functions. Throws {@link InvalidFunctionNameError}
 * naming every one the control plane would refuse.
 */
export function discoverTsFunctionsInDir(functionsDir: string): DiscoveredFunctionRoute[] {
  const found = discoverHandlersInDir(functionsDir)
  const problems = found
    .map((fn) => functionNameProblem(fn.name, fn.path === fn.entrypoint ? basename(fn.path) : `${fn.name}/`))
    .filter((problem): problem is string => problem !== undefined)
  if (problems.length > 0) {
    throw new InvalidFunctionNameError(
      [`The control plane would refuse ${problems.length} function(s) in ${functionsDir}:`, ...problems.map((p) => `  ${p}`)].join("\n"),
    )
  }
  return found
}

/** {@link discoverTsFunctionsInDir}, ending the command with why when a name would be refused. */
export function discoverFunctionsOrExit(functionsDir: string): DiscoveredFunctionRoute[] {
  try {
    return discoverTsFunctionsInDir(functionsDir)
  } catch (err: unknown) {
    if (err instanceof InvalidFunctionNameError) fatalError(err.message)
    throw err
  }
}
