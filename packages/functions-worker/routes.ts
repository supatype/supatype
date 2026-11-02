// Generated from packages/shared/src/function-routes.ts by scripts/functions-worker-source.mjs. Do
// not edit: change that file and run the script, so the worker and the control plane agree.
/**
 * Which entries of a functions or hooks directory the functions worker serves, and by what route
 * name. The worker discovers its routes by this rule and a self-hosted control plane lists them by
 * it, so the list names exactly what answers. The worker cannot import this package: the generator
 * (scripts/functions-worker-source.mjs) copies this file into it as routes.ts, so it must import
 * nothing.
 */

/** The module a directory route runs; a directory without one is not a route. */
export const FUNCTION_ENTRY_FILE = "index.ts"

/**
 * The route the worker serves for `entry`, or undefined for an entry it skips. `_` and `.` prefixed
 * entries are never routes (`_shared`, `.git`). A directory is the route of its name, when it holds
 * {@link FUNCTION_ENTRY_FILE}, which the caller checks. A file is the route of its name without
 * `.ts`; a declaration file (`.d.ts`) and anything else is not one.
 */
export function functionRouteName(entry: string, kind: "directory" | "file"): string | undefined {
  if (entry.startsWith("_") || entry.startsWith(".")) return undefined
  if (kind === "directory") return entry
  return entry.endsWith(".ts") && !entry.endsWith(".d.ts") ? entry.slice(0, -".ts".length) : undefined
}

/**
 * A hook name: letters of either case, digits, `-` and `_`, starting with a letter or digit. Wider
 * than a function name, because the CLI and Cloud take a hook's name from the schema and its folder
 * as written (`onUserCreate`): Cloud stores it as a ConfigMap key, and the worker skips a name that
 * starts with `_` or `.`. Still one path segment: nothing in it can name a parent, a separator or a
 * hidden entry.
 */
export const HOOK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** The hook rule, said for a person. */
export const HOOK_NAME_RULE = 'use letters, digits, "-" and "_", starting with a letter or digit'

/** Whether `name` passes the hook-name rule. */
export function isHookName(name: unknown): name is string {
  return typeof name === "string" && HOOK_NAME.test(name)
}
