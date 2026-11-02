import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

/**
 * `init -y` asked Docker its questions with no limit, so a Docker that does not answer (a paused
 * Docker Desktop leaves `docker info` hanging) held init for as long as it hung. The real CLI runs
 * here against a `docker` that never answers, and has to finish well inside the time it hangs for.
 */
const CLI_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/supatype.js")
const HANG_SECONDS = 90
let dir = ""

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    // The abandoned stand-in docker is still waiting out its sleep in this directory, as a real
    // hung Docker would be; Windows will not remove a directory a process is in. It goes with the
    // temp directory.
  }
})

/** A directory holding a `docker` that waits HANG_SECONDS and says nothing. */
function hangingDocker(root: string): string {
  const bin = join(root, "bin")
  mkdirSync(bin)
  if (process.platform === "win32") {
    writeFileSync(join(bin, "docker.cmd"), `@ping -n ${HANG_SECONDS} 127.0.0.1 >nul\r\n`)
  } else {
    writeFileSync(join(bin, "docker"), `#!/bin/sh\nsleep ${HANG_SECONDS}\n`, { mode: 0o755 })
  }
  return bin
}

/** This process's environment with the hanging docker first on PATH and the real one taken off. */
function environment(bin: string): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH"
  const rest = (process.env[pathKey] ?? "")
    .split(delimiter)
    .filter((entry) => !["docker", "docker.exe"].some((name) => existsSync(join(entry, name))))
  // A registry that refuses at once: only Docker is being timed.
  return { ...process.env, [pathKey]: [bin, ...rest].join(delimiter), npm_config_registry: "http://127.0.0.1:1" }
}

describe("supatype init -y with a Docker that does not answer", () => {
  it("finishes within its own limits, not Docker's", () => {
    dir = mkdtempSync(join(tmpdir(), "st-init-hanging-docker-"))
    const started = Date.now()
    const run = spawnSync(process.execPath, [CLI_BIN, "init", "acme", "-y", "--no-install"], {
      cwd: dir,
      env: environment(hangingDocker(dir)),
      encoding: "utf8",
      timeout: 60_000,
    })
    const took = Date.now() - started
    expect(run.signal, `init was still running after 60s:\n${run.stdout}\n${run.stderr}`).toBeNull()
    expect(run.status).toBe(0)
    expect(took).toBeLessThan(30_000)
  }, 70_000)
})
