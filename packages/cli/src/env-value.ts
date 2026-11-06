/**
 * What an env file can hold in a value: one line of text. A carriage return or line feed ends the
 * line, so the text after it is read as an assignment of its own; the server then refuses to start
 * and logs that text, which was a password in manual test #37. The other control characters and
 * Unicode's line and paragraph separators have no place in a value either.
 */
const CONTROL_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u

/** Whether `value` holds a line break or any other control character. */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value)
}

/**
 * A value an env file writer refused. The message names the key and the file, never the value,
 * which is as likely as not a secret and would otherwise be printed in a terminal or a CI log.
 */
export class EnvValueError extends Error {
  override readonly name = "EnvValueError"

  constructor(readonly key: string, readonly file: string) {
    super(
      `Refused to write ${key} to ${file}: its value has a line break or another control character in it, ` +
        `which would split it across lines of ${file}. Nothing was written. Set ${key} again on one line.`,
    )
  }
}

/** Throws {@link EnvValueError} for the first of `values` that cannot be written on one line of `file`. */
export function assertEnvValues(values: Readonly<Record<string, string>>, file: string): void {
  for (const [key, value] of Object.entries(values)) {
    if (hasControlCharacter(value)) throw new EnvValueError(key, file)
  }
}
