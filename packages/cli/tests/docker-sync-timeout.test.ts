import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { askDockerSync, dockerProgram } from "../src/docker-exec.js"
import { probeDockerDaemonAsync } from "../src/docker-runtime.js"
import type { DockerAnswer, DockerRunner } from "../src/docker-exec.js"

/**
 * Pre-push review: on Windows the synchronous Docker calls ran through a shell, and a timeout
 * killed cmd.exe while docker.exe kept the pipes open, so the call blocked past its limit (the
 * daemon probe, and dev's stale-session check). docker.exe is run directly when it is on PATH.
 */
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      // A killed stand-in may still hold its file for a moment; the temp directory goes with it.
    }
  }
})

/** A directory holding `docker.exe`, which is node: it runs the script it is given. */
function standInDocker(): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-docker-exe-"))
  dirs.push(dir)
  copyFileSync(process.execPath, join(dir, "docker.exe"))
  return dir
}

describe("dockerProgram", () => {
  it("runs docker.exe directly on Windows when it is on PATH", () => {
    const dir = standInDocker()
    expect(dockerProgram(true, { PATH: dir }, "win32")).toEqual({ file: join(dir, "docker.exe"), shell: false })
  })

  it("keeps the shell on Windows when docker.exe is not on PATH, and elsewhere as asked", () => {
    expect(dockerProgram(true, { PATH: tmpdir() }, "win32")).toEqual({ file: "docker", shell: true })
    expect(dockerProgram(false, { PATH: "/usr/bin" }, "linux")).toEqual({ file: "docker", shell: false })
  })
})

describe.runIf(process.platform === "win32")("a synchronous docker call that hangs on Windows", () => {
  // Killing the shell at the limit left docker.exe running, holding what it had open. The stand-in
  // notes that it started, then writes a second file well after the limit: whether that file
  // appears shows whether the docker process itself was ended, or only the shell around it.
  it("ends the hung docker process at its limit, not only the shell around it", async () => {
    const dir = standInDocker()
    const started = join(dir, "started")
    const survived = join(dir, "survived")
    const script = join(dir, "hang.cjs")
    const write = (path: string): string => `require("node:fs").writeFileSync(${JSON.stringify(path)}, "x")`
    writeFileSync(script, `${write(started)}; setTimeout(() => ${write(survived)}, 5000)`)
    const env = { ...process.env, PATH: `${dir}${delimiter}${process.env["PATH"] ?? ""}` }
    const answer = askDockerSync([script], { shell: true, timeoutMs: 3_000, env })
    expect(answer.timedOut).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    expect(existsSync(started)).toBe(true)
    expect(existsSync(survived)).toBe(false)
  }, 30_000)
})

/** A Docker whose `version` says it is paused and whose `info` never answers, as a paused Docker Desktop does. */
const PAUSED: DockerRunner = (args) =>
  args[0] === "version"
    ? Promise.resolve<DockerAnswer>({ status: 1, stdout: "28.0.1", stderr: "Docker Desktop is manually paused", timedOut: false, missing: false })
    : new Promise<DockerAnswer>(() => undefined)

describe("probeDockerDaemonAsync on a paused Docker Desktop", () => {
  it("says what docker version said, not that Docker did not answer", async () => {
    const probe = await probeDockerDaemonAsync(PAUSED, 300)
    expect(probe).toEqual({ ok: false, reason: "daemon_unavailable", detail: "Docker Desktop is manually paused" })
  })
})
