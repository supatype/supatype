import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { errorCode } from "./error-message.js"
import { uniqueFileToken } from "./unique-file-token.js"

/** Rename errors Windows gives while another process holds the target open without delete sharing. */
const HELD_OPEN = new Set(["EPERM", "EACCES", "EBUSY"])

/**
 * Writes `text` to `path` unless it already holds it. Through a temporary file and a rename, so a
 * Deno another serve has running never reads a half-written module. Left alone, a file keeps its
 * mtime, which a running dev's watcher reads as changed source: rewriting the same bytes restarted
 * its functions worker on every push (0.9.2 round 4, S-3). Whether it wrote.
 *
 * On Windows a rename onto a file another process holds open fails with EPERM, where writing it in
 * place succeeds: push failed with a raw `EPERM: operation not permitted, rename` and left its
 * temporary files behind (0.9.2 round 5, S-6). Then the file is written in place instead.
 */
export function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false
  const temporary = `${path}.${uniqueFileToken()}.tmp`
  writeFileSync(temporary, text, "utf8")
  try {
    renameSync(temporary, path)
  } catch (err) {
    rmSync(temporary, { force: true })
    if (!HELD_OPEN.has(errorCode(err) ?? "")) throw err
    writeFileSync(path, text, "utf8")
  }
  return true
}
