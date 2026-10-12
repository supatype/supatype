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
