import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * A program `bun build --compile` makes loads `.env`, `.env.local` and `.env.development.local`
 * from the directory it runs in, and `bunfig.toml` (whose `preload` runs code), unless told not
 * to. The CLI runs in a project directory, so the compiled CLI read the project's SERVICE_ROLE_KEY
 * and its front end's local URL and key into its own environment, which the CLI under Node never
 * did. `diff` then took the service-role path to a stack that was not running, and `supatype build`
 * read the dev values as if a host had set them.
 *
 * The test compiles a probe with exactly the flags the release script compiles the CLI with.
 */
const SCRIPT = join(import.meta.dirname, "../scripts/build-release-artifacts.sh")
const hasBun = spawnSync("bun", ["--version"], { shell: process.platform === "win32" }).status === 0

/** The flags between `bun build "$ENTRY"` and `--target` in the release script. */
function releaseCompileFlags(): string[] {
  const line = readFileSync(SCRIPT, "utf8")
    .split(/\r?\n/)
    .find((text) => text.trimStart().startsWith("bun build \"$ENTRY\""))
  if (line === undefined) throw new Error("build-release-artifacts.sh has no `bun build \"$ENTRY\"` line")
  const words = (line.split("\"$ENTRY\"")[1] ?? "").split(/\s+/).filter((word) => word.length > 0)
  const target = words.findIndex((word) => word.startsWith("--target"))
  return target === -1 ? words : words.slice(0, target)
}

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function writeProject(root: string): void {
  writeFileSync(join(root, ".env"), "SERVICE_ROLE_KEY=from-dot-env\n")
  writeFileSync(join(root, ".env.development.local"), "VITE_SUPATYPE_URL=http://localhost:1\n")
  writeFileSync(join(root, "bunfig.toml"), "preload = [\"./preload.ts\"]\n")
  writeFileSync(join(root, "preload.ts"), "process.env.PRELOADED = \"ran\"\n")
  writeFileSync(
    join(root, "probe.ts"),
    "console.log(JSON.stringify([process.env.SERVICE_ROLE_KEY, process.env.VITE_SUPATYPE_URL, process.env.PRELOADED]))\n",
  )
}

describe.skipIf(!hasBun)("the compiled CLI", () => {
  it("reads nothing from the project directory it runs in", () => {
    dir = mkdtempSync(join(tmpdir(), "supatype-compiled-"))
    writeProject(dir)
    const exe = join(dir, process.platform === "win32" ? "probe.exe" : "probe")
    const flags = releaseCompileFlags()
    expect(flags).toContain("--compile")
    const build = spawnSync("bun", ["build", join(dir, "probe.ts"), ...flags, "--outfile", exe], { encoding: "utf8", shell: process.platform === "win32" })
    expect(build.status, build.stderr).toBe(0)
    const run = spawnSync(exe, [], { cwd: dir, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout.trim())).toEqual([null, null, null])
  }, 120_000)

  // Issue 61: a seed's builder imports `@supatype/cli/seed` from the project's node_modules, and a
  // compiled program reads no package.json at run time unless told to, so it resolved no package
  // there: "Cannot find module '@supatype/cli/seed'". Every seed failed from the binary.
  it("resolves a package from the project's node_modules, by its exports", () => {
    dir = mkdtempSync(join(tmpdir(), "supatype-compiled-"))
    const pkg = join(dir, "node_modules", "@probe", "lib")
    mkdirSync(join(pkg, "dist"), { recursive: true })
    const exports = { "./seed": "./dist/seed.js" }
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@probe/lib", type: "module", exports }))
    writeFileSync(join(pkg, "dist", "seed.js"), "export const answer = 42\n")
    writeFileSync(join(dir, "seed.ts"), 'import { answer } from "@probe/lib/seed"\nconsole.log(answer)\n')
    writeFileSync(join(dir, "probe.ts"), 'import { pathToFileURL } from "node:url"\nawait import(pathToFileURL(process.argv[2] ?? "").href)\n')
    const exe = join(dir, process.platform === "win32" ? "probe.exe" : "probe")
    const flags = [...releaseCompileFlags(), "--outfile", exe]
    const build = spawnSync("bun", ["build", join(dir, "probe.ts"), ...flags], { encoding: "utf8", shell: process.platform === "win32" })
    expect(build.status, build.stderr).toBe(0)
    const env = { PATH: process.env["PATH"] ?? "" }
    const run = spawnSync(exe, [join(dir, "seed.ts")], { cwd: dir, encoding: "utf8", env })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout.trim()).toBe("42")
  }, 120_000)
})
