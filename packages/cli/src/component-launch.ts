/**
 * How native dev starts a service it runs from this repository's packages (realtime, storage):
 * an executable, or Node on a JavaScript entry.
 */
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface ComponentLaunchSpec {
  bin: string
  args: string[]
}

const CLI_PKG_DIR = dirname(fileURLToPath(import.meta.url))

/** Node on `entry` for a `.js`, `.mjs` or `.cjs` file, the file itself otherwise. */
function launchFor(path: string): ComponentLaunchSpec {
  return /\.(c|m)?js$/.test(path) ? { bin: process.execPath, args: [path] } : { bin: path, args: [] }
}

/** The launch an `overrides.<name>` path names, resolved against `cwd`; throws when it is missing. */
export function launchFromOverride(name: string, override: string, cwd: string): ComponentLaunchSpec {
  const resolved = resolve(cwd, override)
  if (!existsSync(resolved)) throw new Error(`[overrides] ${name} path does not exist: ${resolved}`)
  return launchFor(resolved)
}

/** Contributor fallback: Node on `packages/<pkg>/dist/index.js` beside the CLI package, when built. */
export function monorepoLaunch(pkg: string): ComponentLaunchSpec | null {
  const entry = resolve(CLI_PKG_DIR, `../../${pkg}/dist/index.js`)
  return existsSync(entry) ? launchFor(entry) : null
}
