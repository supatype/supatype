import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { denoEnvFileArgs } from "../src/commands/functions.js"

/**
 * `functions serve` hands Deno the functions' `.env.local`. It passed `--env-file` and the path as
 * two arguments, but Deno's `--env-file` takes its value only after `=`, so Deno read the path as
 * the script to run and served nothing. `functions new` creates that file, so every project that had
 * made a function this way could not serve.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const denoAvailable = spawnSync("deno", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0

describe("functions serve's env file", () => {
  it("is nothing when the file does not exist", () => {
    expect(denoEnvFileArgs(join(tmpdir(), "supatype-no-such-dir", ".env.local"))).toEqual([])
  })

  it.skipIf(!denoAvailable)("reaches the script Deno runs, which is still the router", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-serve-env-"))
    dirs.push(dir)
    const envFile = join(dir, ".env.local")
    writeFileSync(envFile, "FROM_ENV_FILE=loaded\n")
    const script = join(dir, "router.ts")
    writeFileSync(script, `console.log("router saw " + Deno.env.get("FROM_ENV_FILE"))\n`)
    const run = spawnSync("deno", ["run", "--allow-env", "--allow-read", ...denoEnvFileArgs(envFile), script], {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 60_000,
    })
    expect(`${run.stdout}${run.stderr}`).toContain("router saw loaded")
    expect(run.status).toBe(0)
  }, 70_000)
})
