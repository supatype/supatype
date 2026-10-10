import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * What `npm publish` would put in the CLI's tarball.
 *
 * With no `files` list, npm packs everything that is not ignored: the sources, the tests, turbo
 * logs, tsconfigs, and a stray eval snippet (`src/supatype-eval-<ms>.mts`) along with its compiled
 * copy in `dist`. The list keeps the tarball to what the installed CLI reads at runtime.
 */

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..")

interface PackEntry { files: Array<{ path: string }> }

function packedFiles(): string[] {
  // `shell` so Windows finds `npm.cmd`; the arguments are fixed.
  const result = spawnSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: cliDir,
    encoding: "utf8",
    shell: true,
  })
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`)
  const [entry] = JSON.parse(result.stdout) as PackEntry[]
  return entry!.files.map((file) => file.path.split("\\").join("/"))
}

describe("the published CLI package", () => {
  const files = packedFiles()

  it("holds what the CLI needs at runtime", () => {
    for (const path of [
      "package.json",
      "bin/supatype.js",
      "dist/cli.js",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/seed.js",
      "dist/seed.d.ts",
      "dist/scripts/postinstall.js",
      "dist/assets/supatype-logo-wordmark.ascii.txt",
      "releases/deno/VERSION",
      "deno.d.ts",
      "LICENSE",
    ]) {
      expect(files).toContain(path)
    }
  })

  it("holds no eval leftovers", () => {
    expect(files.filter((path) => path.includes("supatype-eval-"))).toEqual([])
  })

  it("holds no sources, tests or build bookkeeping", () => {
    const junk = files.filter((path) =>
      /^(src|tests|\.turbo|scripts)\/|^bin\/dev-entry\.ts$|tsconfig|tsbuildinfo|vitest\.config/.test(
        path,
      ),
    )
    expect(junk).toEqual([])
  })
})

describe("the CLI's source tree", () => {
  it("tracks no eval snippet", () => {
    const result = spawnSync("git", ["ls-files", "--", "src/supatype-eval-*"], {
      cwd: cliDir,
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("")
  })
})
