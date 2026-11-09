import type { SpawnSyncReturns } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import type { DockerAnswer, DockerRunner } from "../src/docker-exec.js"

const spawnSyncMock = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}))

vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => false }))

import {
  DOCKER_WAIT_MS,
  dockerWaitMs,
  formatDockerUnavailableMessage,
  probeDockerDaemon,
  probeDockerDaemonRetrying,
} from "../src/docker-runtime.js"

/**
 * 0.9.1 release test, FF20: on a loaded machine `supatype dev` gave up with "Docker did not answer
 * within 5s ... try again in a moment", exit 1, six times in one Vue run and three in a bun run,
 * each time on a Docker that was running and answered the next attempt. A Docker that is slow is
 * waited for, up to a total (`SUPATYPE_DOCKER_TIMEOUT`, in seconds, else a minute), with a line
 * saying so; a Docker that says it cannot be reached still fails at once.
 */
function answer(overrides: Partial<SpawnSyncReturns<string>> & Pick<SpawnSyncReturns<string>, "status">): SpawnSyncReturns<string> {
  return { stdout: "", stderr: "", pid: 0, output: ["", ""], signal: null, ...overrides }
}

const TIMED_OUT = answer({ status: null, error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }) })
const VERSION_OK = answer({ status: 0, stdout: "28.0.1" })
const INFO_OK = answer({ status: 0, stdout: "Server Version: 28.0.1" })
const REFUSED = answer({
  status: 1,
  stdout: "28.0.1",
  stderr: "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running",
})

/** A clock that moves on `stepMs` each time it is read, standing in for asks that each take that long. */
function clock(stepMs: number): () => number {
  let now = 0
  return () => (now += stepMs)
}

const WAITING = /Waiting for Docker to answer/

describe("probeDockerDaemon on a Docker that is slow but running", () => {
  let logMock: MockInstance<typeof console.log>

  beforeEach(() => {
    spawnSyncMock.mockReset()
    logMock = vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => logMock.mockRestore())

  it("keeps asking past a second silence, and takes the answer when it comes", () => {
    spawnSyncMock
      .mockReturnValueOnce(TIMED_OUT)
      .mockReturnValueOnce(TIMED_OUT)
      .mockReturnValueOnce(TIMED_OUT)
      .mockReturnValueOnce(VERSION_OK)
      .mockReturnValueOnce(INFO_OK)
    expect(probeDockerDaemon({ now: clock(5_000) })).toEqual({ ok: true })
    expect(spawnSyncMock).toHaveBeenCalledTimes(5)
  })

  it("says once that it is waiting, and how to wait longer", () => {
    spawnSyncMock.mockReturnValueOnce(TIMED_OUT).mockReturnValueOnce(TIMED_OUT).mockReturnValueOnce(VERSION_OK).mockReturnValueOnce(INFO_OK)
    probeDockerDaemon({ now: clock(5_000) })
    const lines = logMock.mock.calls.map((call) => String(call[0]))
    expect(lines.filter((line) => WAITING.test(line))).toHaveLength(1)
    expect(lines.find((line) => WAITING.test(line))).toMatch(/SUPATYPE_DOCKER_TIMEOUT/)
  })

  it("asks quickly first, then gives each later ask longer", () => {
    spawnSyncMock.mockReturnValueOnce(TIMED_OUT).mockReturnValueOnce(VERSION_OK).mockReturnValueOnce(INFO_OK)
    probeDockerDaemon({ now: clock(1) })
    expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 5_000 })
    expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 15_000 })
  })

  it("gives up once the whole wait is spent, naming the wait and the setting", () => {
    spawnSyncMock.mockReturnValue(TIMED_OUT)
    const probe = probeDockerDaemon({ now: clock(20_000) })
    expect(probe).toEqual({ ok: false, reason: "daemon_unresponsive", detail: "Docker did not answer within 60s" })
    if (probe.ok) return
    const message = formatDockerUnavailableMessage(probe)
    expect(message).not.toMatch(/not running/)
    expect(message).toMatch(/SUPATYPE_DOCKER_TIMEOUT/)
  })

  it("does not wait on a Docker that says it cannot be reached", () => {
    spawnSyncMock.mockReturnValueOnce(REFUSED)
    expect(probeDockerDaemon({ now: clock(1) })).toMatchObject({ ok: false, reason: "daemon_unavailable" })
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
    expect(logMock.mock.calls.some((call) => WAITING.test(String(call[0])))).toBe(false)
  })
})

/** A Docker whose `info` answers after `delayMs`, every time, as a loaded Docker does. */
function slowInfo(delayMs: number): { runner: DockerRunner; infoCalls: () => number } {
  let info = 0
  const runner: DockerRunner = (args) => {
    if (args[0] === "version") return Promise.resolve<DockerAnswer>({ status: 0, stdout: "28.0.1", stderr: "", timedOut: false, missing: false })
    info += 1
    return new Promise<DockerAnswer>((resolve) =>
      setTimeout(() => resolve({ status: 0, stdout: "ok", stderr: "", timedOut: false, missing: false }), delayMs),
    )
  }
  return { runner, infoCalls: () => info }
}

describe("probeDockerDaemonRetrying (dev's compose runs)", () => {
  let logMock: MockInstance<typeof console.log>
  beforeEach(() => (logMock = vi.spyOn(console, "log").mockImplementation(() => {})))
  afterEach(() => logMock.mockRestore())

  it("waits for a Docker slower than the first ask's limit", async () => {
    const docker = slowInfo(150)
    expect(await probeDockerDaemonRetrying(docker.runner, { firstAskMs: 50, askMs: 1_000 })).toEqual({ ok: true })
    expect(docker.infoCalls()).toBe(2)
    expect(logMock.mock.calls.some((call) => WAITING.test(String(call[0])))).toBe(true)
  })

  it("keeps asking a Docker that stays silent until the wait is spent", async () => {
    const docker = slowInfo(10_000)
    const probe = await probeDockerDaemonRetrying(docker.runner, { firstAskMs: 20, askMs: 20, totalMs: 600 })
    expect(probe).toEqual({ ok: false, reason: "daemon_unresponsive", detail: "Docker did not answer within 1s" })
    expect(docker.infoCalls()).toBeGreaterThan(2)
  })
})

describe("dockerWaitMs", () => {
  it("is a minute when SUPATYPE_DOCKER_TIMEOUT is unset", () => {
    expect(DOCKER_WAIT_MS).toBe(60_000)
    expect(dockerWaitMs({})).toBe(60_000)
  })

  it("takes SUPATYPE_DOCKER_TIMEOUT in seconds", () => {
    expect(dockerWaitMs({ SUPATYPE_DOCKER_TIMEOUT: "180" })).toBe(180_000)
    expect(dockerWaitMs({ SUPATYPE_DOCKER_TIMEOUT: " 90 " })).toBe(90_000)
  })

  it.each(["", "0", "abc", "-5", "1.5"])("ignores %j", (value) => {
    expect(dockerWaitMs({ SUPATYPE_DOCKER_TIMEOUT: value })).toBe(60_000)
  })
})
