/**
 * The Node executable the CLI starts a JavaScript entry with: Vite's `vite.js`, or a service's
 * built `.js` entry.
 *
 * Under Node that is `process.execPath`. In the compiled binary `process.execPath` is the supatype
 * program itself, which read `vite.js` as a subcommand, exited with `unknown command`, and was
 * restarted for the rest of the session while every app route answered 502 (#28). There it is the
 * first `node` on PATH.
 */
import { statSync } from "node:fs"
import { delimiter, join } from "node:path"
import { isCompiledBinary } from "./cli-install-method.js"

const NODE_EXECUTABLE = process.platform === "win32" ? "node.exe" : "node"

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
}

/** The first `node` on PATH, or null. Windows writes a PATH entry with spaces in quotes. */
function nodeOnPath(): string | null {
  const dirs = (process.env["PATH"] ?? process.env["Path"] ?? "").split(delimiter)
  for (const dir of dirs) {
    const unquoted = dir.trim().replace(/^"(.*)"$/, "$1")
    if (unquoted === "") continue
    const candidate = join(unquoted, NODE_EXECUTABLE)
    if (isFile(candidate)) return candidate
  }
  return null
}

/**
 * Node, to run `entry` with. Throws when the compiled binary finds none on PATH: the binary runs
 * without Node, but a JavaScript entry cannot, and a clear refusal beats a task restarting forever.
 */
export function nodeExecutable(entry: string): string {
  if (!isCompiledBinary()) return process.execPath
  const node = nodeOnPath()
  if (node !== null) return node
  throw new Error(
    `Running ${entry} needs Node.js, and there is no ${NODE_EXECUTABLE} on PATH. ` +
      "Install Node.js (https://nodejs.org) or put it on PATH, then run the command again.",
  )
}
