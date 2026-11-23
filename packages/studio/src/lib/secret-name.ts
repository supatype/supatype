/**
 * The rule for a function secret's name (D-65): letters, digits and underscore, not starting with a
 * digit, so it is also a valid environment variable name in the worker.
 * Replaced at merge by `functionSecretNameProblem` from `@supatype/types`, whose message this repeats exactly.
 */
export const SECRET_NAME_RULE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Why `name` is not a secret name, or null when it is allowed (or empty, which is not a problem yet). */
export function secretNameProblem(name: string): string | null {
  if (name === "" || SECRET_NAME_RULE.test(name)) return null
  return `"${name}" is not a valid secret name: use letters, digits and underscore, and do not start with a digit.`
}
