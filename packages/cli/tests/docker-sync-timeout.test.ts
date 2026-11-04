import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

/** When the hung stand-in would write its second file, from its start: well past the call's limit. */
const SURVIVES_AFTER_MS = 20_000

describe.runIf(process.platform === "win32")("a synchronous docker call that hangs on Windows", () => {
  // Killing the shell at the limit left docker.exe running, holding what it had open. The stand-in
  // notes when it started, then writes a second file well after the limit: whether that file
  // appears shows whether the docker process itself was ended, or only the shell around it.
  //
  // The check waits for the moment the stand-in would have written it, measured from when it
  // started, not from the limit: on a loaded machine the stand-in can take seconds to start, and a
  // fixed wait either ended too soon to tell or ran out before the stand-in had begun.
  it("ends the hung docker process at its limit, not only the shell around it", async () => {
    const dir = standInDocker()
    const started = join(dir, "started")
    const survived = join(dir, "survived")
    const script = join(dir, "hang.cjs")
    const write = (path: string, text: string): string => `require("node:fs").writeFileSync(${JSON.stringify(path)}, ${text})`
    writeFileSync(script, `${write(started, "String(Date.now())")}; setTimeout(() => ${write(survived, '"x"')}, ${SURVIVES_AFTER_MS})`)
    const env = { ...process.env, PATH: `${dir}${delimiter}${process.env["PATH"] ?? ""}` }
    const answer = askDockerSync([script], { shell: true, timeoutMs: 10_000, env })
    expect(answer.timedOut).toBe(true)
    expect(existsSync(started)).toBe(true)
    const wouldSurviveAt = Number(readFileSync(started, "utf8")) + SURVIVES_AFTER_MS + 1_000
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, wouldSurviveAt - Date.now())))
    expect(existsSync(survived)).toBe(false)
  }, 90_000)
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
