/**
 * Changing one variable in the text of an env file, finding its lines as the dotenv parser reads
 * them ({@link splitAssignment}): `export KEY=value` is KEY, and a comment is nothing. Every other
 * line is kept as it is, its line ending included.
 */
import { splitAssignment } from "./dotenv-parse.js"
import { assertEnvValues } from "./env-value.js"

/** Whether `line` assigns `key`. */
const assigns = (line: string, key: string): boolean => splitAssignment(line)?.key === key

/** `line`'s ending kept on its replacement, so a CRLF file stays CRLF. */
const endingOf = (line: string): string => (line.endsWith("\r") ? "\r" : "")

/**
 * `text` with `key` set to `value`: its first assignment replaced and any later one dropped, so the
 * file says it once, or a line added at the end when there is none. A value that cannot go on one
 * line of `file` is refused, naming `key` and `file` ({@link assertEnvValues}).
 */
export function withEnvValue(text: string, key: string, value: string, file: string): string {
  assertEnvValues({ [key]: value }, file)
  let found = false
  const lines = text.split("\n").flatMap((line) => {
    if (!assigns(line, key)) return [line]
    if (found) return []
    found = true
    return [`${key}=${value}${endingOf(line)}`]
  })
  if (found) return lines.join("\n")
  const kept = text.trimEnd()
  return `${kept}${kept === "" ? "" : "\n"}${key}=${value}\n`
}

/**
 * Whether the text of `line` before its first `=`, trimmed and without a leading `export `, is
 * `key`. Unlike {@link assigns} it does not hold the name to the secret name rule, so a line the
 * dotenv parser ignores (`OLD-NAME=x`) can still be found.
 */
function namesKey(line: string, key: string): boolean {
  const trimmed = line.trim().replace(/^export\s+/, "")
  if (trimmed.startsWith("#")) return false
  const eq = trimmed.indexOf("=")
  return eq > 0 && trimmed.slice(0, eq).trim() === key
}

/**
 * `text` without any line naming `key`, and how many lines that was. For unset only: it also
 * removes a line whose name breaks the secret name rule. Every other line stays as it is.
 */
export function withoutEnvValue(text: string, key: string): { text: string; removed: number } {
  const lines = text.split("\n")
  const kept = lines.filter((line) => !namesKey(line, key))
  return { text: kept.join("\n"), removed: lines.length - kept.length }
}
