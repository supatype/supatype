import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { isBuiltin } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isJsonObject, isShape } from "@supatype/shared"
import { parseJsonAs } from "./support/json.js"

/**
 * What the published package loads with Node, and what it may load it from.
 *
 * Installed from npm, the package runs the compiled program for every command, and Node loads only
 * the starter (`dist/cli-launcher.js`) and the two library entries an app imports: `defineConfig`
 * from `.` and the seed helpers from `./seed`. Each of those may import only what the package
 * lists in `dependencies`, and `dependencies` lists nothing else: anything missing breaks an
 * install, and anything extra is installed into every app for nothing, where npm may hoist it to
 * resolve the app's own copy of a framework, as `ink` did with React.
 *
 * Reads the built dist, which is what ships.
 */

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const ENTRIES = ["dist/cli-launcher.js", "dist/index.js", "dist/seed.js"]

/**
 * `import ... from "x"`, `export ... from "x"` and `import "x"`, then `import("x")` with a literal.
 * The specifier's characters are spelled out so that string literals in the code, which can follow
 * the word `from` too, do not read as imports.
 */
const STATIC_IMPORT = /(?:\bfrom\s*|\bimport\s+)["']([@\w./:-]+)["']/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([@\w./:-]+)["']/g

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
}

/** Every module reachable from `entry` through relative imports, and every package they import. */
function reachedFrom(entry: string, dynamic: boolean): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const visit = (file: string): void => {
    if (modules.has(file)) return
    modules.add(file)
    const source = readFileSync(file, "utf8")
    const found = [...source.matchAll(STATIC_IMPORT), ...(dynamic ? source.matchAll(DYNAMIC_IMPORT) : [])]
    for (const [, specifier = ""] of found) {
      if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier))
      else if (!isBuiltin(specifier)) packages.add(packageName(specifier))
    }
  }
  visit(join(cliDir, entry))
  return { modules, packages }
}

const dependencies = Object.keys(
  parseJsonAs(readFileSync(join(cliDir, "package.json"), "utf8"), isShape({ dependencies: isJsonObject })).dependencies,
)

describe("the published CLI package", () => {
  it("depends on exactly the packages its Node entries load", () => {
    const loaded = new Set(ENTRIES.flatMap((entry) => [...reachedFrom(entry, true).packages]))
    expect([...loaded].sort()).toEqual([...dependencies].sort())
  })

  // The starter runs before every command. Each module it loads before starting a cached program
  // is time every command pays, and a package there could reach the app's node_modules.
  it("starts a cached program having loaded no package and a handful of modules", () => {
    const { modules, packages } = reachedFrom("dist/cli-launcher.js", false)
    expect([...packages]).toEqual([])
    // The starter, its notice about old versions and the sizes it adds up, the cache path, the
    // stamped version and the stop signals. Each is a small module of Node built-ins.
    expect(modules.size).toBeLessThanOrEqual(7)
  })
})
