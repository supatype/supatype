/** Sources the functions worker imports: a handler and the modules and JSON it imports. */
const WORKER_SOURCE_FILE = /\.(?:ts|tsx|mts|js|jsx|mjs|json)$/

/**
 * Whether the functions worker loads the file at `path`, relative to a functions or hooks
 * directory, with `/` or `\` between its parts: a source file, never a dotfile, and never inside a
 * dot directory (.git, an editor's). The env files beside the functions are dotfiles, which the
 * worker reads on each call instead.
 *
 * One rule for both sides: a deploy sends exactly these files, and a self-hosted control plane
 * hashes exactly these to tell whether its worker is stale. The deploy used to send only .ts and
 * .js, so a function importing its JSON or an .mjs module was deployed without them.
 */
export function workerLoadsFile(path: string): boolean {
  const parts = path.split(/[\\/]/)
  const name = parts.at(-1) ?? ""
  return parts.every((part) => !part.startsWith(".")) && WORKER_SOURCE_FILE.test(name)
}
