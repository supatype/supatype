/**
 * How native dev starts a service it runs from this repository's packages (realtime, storage):
 * an executable, or Node on a JavaScript entry.
 */
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isShape, isString } from "@supatype/shared"
import { readJsonFile } from "./json-file.js"

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

/** The process entry a service's package.json declares (`supatype.entry`): realtime's index.js only exports. */
const isDeclaredEntry = isShape({ supatype: isShape({ entry: isString }) })

/** `packages/<pkg>/<process entry>` beside the CLI package, as its package.json declares it, else `dist/index.js`. */
export function monorepoEntry(pkg: string): string {
  const root = resolve(CLI_PKG_DIR, "..", "..", pkg)
  const declared = readJsonFile(join(root, "package.json"), isDeclaredEntry)
  return resolve(root, declared?.supatype.entry ?? "dist/index.js")
}

/** Contributor fallback: Node on the package's built process entry beside the CLI package, when built. */
export function monorepoLaunch(pkg: string): ComponentLaunchSpec | null {
  const entry = monorepoEntry(pkg)
  return existsSync(entry) ? launchFor(entry) : null
}
