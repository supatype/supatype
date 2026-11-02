/**
 * Changing one variable in the text of an env file, finding its lines as the dotenv parser reads
 * them ({@link splitAssignment}): `export KEY=value` is KEY, and a comment is nothing. Every other
 * line is kept as it is, its line ending included.
 */
import { splitAssignment } from "./dotenv-parse.js"

/** Whether `line` assigns `key`. */
const assigns = (line: string, key: string): boolean => splitAssignment(line)?.key === key

/** `line`'s ending kept on its replacement, so a CRLF file stays CRLF. */
const endingOf = (line: string): string => (line.endsWith("\r") ? "\r" : "")

/**
 * `text` with `key` set to `value`: its first assignment replaced and any later one dropped, so the
 * file says it once, or a line added at the end when there is none.
 */
export function withEnvValue(text: string, key: string, value: string): string {
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

/** `text` without any assignment of `key`, and whether it had one. */
export function withoutEnvValue(text: string, key: string): { text: string; removed: boolean } {
  const lines = text.split("\n")
  const kept = lines.filter((line) => !assigns(line, key))
  return { text: kept.join("\n"), removed: kept.length < lines.length }
}
