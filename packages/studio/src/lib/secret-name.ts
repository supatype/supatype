/**
 * The rule for a function secret's name (D-65): letters, digits and underscore, not starting with a
 * digit, so it is also a valid environment variable name in the worker. `@supatype/types` carries the
 * same rule for the servers and the CLI; this copy exists until that export lands, and the two are
 * to be joined at merge.
 */
export const SECRET_NAME_RULE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** What is wrong with `name` as a secret name, or null when it is allowed. An empty name is not a problem yet. */
export function secretNameProblem(name: string): string | null {
  if (name === "" || SECRET_NAME_RULE.test(name)) return null
  return "Use letters, digits and underscores only, and do not start with a digit."
}
