import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { describeInstallFailure, installDependencies, type InstallCommand } from "../src/init-setup-steps.js"

/**
 * D-92: `supatype init` said only "Dependency install failed" when the install failed, so a failing
 * lifecycle script (the client's `prepare`) looked the same as a missing release key. The failure now
 * names the script and shows the last lines of what it printed.
 */
let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-init-reason-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A stand-in package manager: node, printing `lines` (stdout) and then exiting with `code`. */
function fakePackageManager(lines: string[], code = 1): InstallCommand {
  // exitCode, not process.exit: on Linux a pipe write is asynchronous, and exiting at once could drop
  // the last lines before they reached the parent (CI lost "line 199" this way).
  const script = `for (const l of ${JSON.stringify(lines)}) console.log(l); process.exitCode = ${code}`
  return { file: process.execPath, args: ["-e", script], shell: false }
}

const NPM_PREPARE = [
  "added 120 packages in 4s",
  "> demo-app@0.1.0 prepare",
  "> supatype-prepare",
  "supatype-prepare: no release key for this build",
  "npm error code 1",
  "npm error command failed",
  "npm error command sh -c supatype-prepare",
]

const PNPM_PREPARE = [
  "Progress: resolved 40, reused 40",
  "node_modules/@supatype/client prepare$ supatype-prepare",
  "node_modules/@supatype/client prepare: no release key for this build",
  "node_modules/@supatype/client prepare: Failed",
  " ELIFECYCLE  Command failed with exit code 1.",
]

describe("a failed install names what failed", () => {
  it("names the prepare script from npm's output", async () => {
    const result = await installDependencies(dir, fakePackageManager(NPM_PREPARE), () => undefined)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.script).toBe("prepare")
    expect(result.failure.command).toBe("supatype-prepare")
    expect(result.failure.exitCode).toBe(1)
    expect(result.failure.tail).toContain("supatype-prepare: no release key for this build")
  })

  it("names the prepare script and its package from pnpm's output", async () => {
    const result = await installDependencies(dir, fakePackageManager(PNPM_PREPARE), () => undefined)
    if (result.ok) throw new Error("the install should have failed")
    expect(result.failure.script).toBe("prepare")
    expect(result.failure.where).toBe("node_modules/@supatype/client")
  })

  it("reports success as ok", async () => {
    expect(await installDependencies(dir, fakePackageManager(["done"], 0), () => undefined)).toEqual({ ok: true })
  })

  it("says what it could not run when the package manager is missing", async () => {
    const result = await installDependencies(dir, { file: "supatype-no-such-package-manager", args: ["install"], shell: false }, () => undefined)
    if (result.ok) throw new Error("the install should have failed")
    expect(result.failure.cause).toContain("Could not run supatype-no-such-package-manager")
  })
})

describe("describeInstallFailure", () => {
  it("states the script, the command, the exit code and the last lines", async () => {
    const result = await installDependencies(dir, fakePackageManager(NPM_PREPARE), () => undefined)
    if (result.ok) throw new Error("the install should have failed")
    const text = describeInstallFailure("npm", result.failure)
    expect(text).toContain("Dependency install failed")
    expect(text).toContain('"prepare" script')
    expect(text).toContain("supatype-prepare")
    expect(text).toContain("exit code 1")
    expect(text).toContain("supatype-prepare: no release key for this build")
    expect(text).toContain('Run "npm install"')
  })

  it("keeps only the last lines of a long output", async () => {
    const noisy = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    const result = await installDependencies(dir, fakePackageManager(noisy), () => undefined)
    if (result.ok) throw new Error("the install should have failed")
    const text = describeInstallFailure("npm", result.failure)
    expect(text).toContain("line 199")
    expect(text).not.toContain("line 100\n")
    expect(text.split("\n").length).toBeLessThan(40)
  })

  it("does not print a token, a password in a URL, or a secret assignment", async () => {
    const secrets = [
      "npm error //registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "fetch https://deploy:hunter2hunter2@registry.example.com/pkg failed",
      "NPM_TOKEN=abcdef123456",
      "Authorization: Bearer abc.def.ghi-jkl",
    ]
    const result = await installDependencies(dir, fakePackageManager(secrets), () => undefined)
    if (result.ok) throw new Error("the install should have failed")
    const text = describeInstallFailure("npm", result.failure)
    for (const leaked of ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "hunter2hunter2", "abcdef123456", "abc.def.ghi-jkl"]) {
      expect(text).not.toContain(leaked)
    }
  })

  it("cuts a very long line", async () => {
    const result = await installDependencies(dir, fakePackageManager(["x".repeat(5000)]), () => undefined)
    if (result.ok) throw new Error("the install should have failed")
    expect(describeInstallFailure("npm", result.failure).length).toBeLessThan(1500)
  })
})
