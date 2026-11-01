/**
 * A function name: lowercase letters, digits, `-` and `_`, starting with a letter or digit. The
 * control plane refuses any other name, and nothing in one can name a parent, a separator or a
 * hidden entry. The CLI checks the same rule, so a folder the server would refuse (`sendEmail`) is
 * named when it is created or deployed rather than by the server afterwards.
 */
export const FUNCTION_NAME = /^[a-z0-9][a-z0-9_-]*$/

/** The rule, said for a person. */
export const FUNCTION_NAME_RULE = 'use lowercase letters, digits, "-" and "_", starting with a letter or digit'

/** Whether `name` passes the function-name rule. */
export function isFunctionName(name: unknown): name is string {
  return typeof name === "string" && FUNCTION_NAME.test(name)
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
