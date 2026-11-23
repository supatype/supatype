/**
 * The one rule for the name of a function secret (an environment variable of an edge function),
 * shared by the CLI, Studio, the self-host server and the cloud control plane (decision D-65):
 * letters, digits and underscore, not starting with a digit. The server layers repeat the message
 * text exactly, so a refusal reads the same wherever it is raised.
 */
export const FUNCTION_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The rule in words, as the tail of every refusal. */
export const FUNCTION_SECRET_NAME_RULE = "use letters, digits and underscore, and do not start with a digit."

/** Whether `name` may name a function secret. */
export function isFunctionSecretName(name: string): boolean {
  return FUNCTION_SECRET_NAME_PATTERN.test(name)
}

/** Why `name` is not a function secret name, or undefined when it is one. */
export function functionSecretNameProblem(name: string): string | undefined {
  if (isFunctionSecretName(name)) return undefined
  return `"${name}" is not a valid secret name: ${FUNCTION_SECRET_NAME_RULE}`
}
