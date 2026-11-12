import type { SpawnSyncReturns } from "node:child_process"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { DockerAnswer, DockerRunner } from "../src/docker-exec.js"

const spawnSyncMock = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}))

vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => false }))

import { formatDockerUnavailableMessage, probeDockerDaemon, probeDockerDaemonRetrying } from "../src/docker-runtime.js"

/**
 * `supatype diff`, run right after a diff that failed on a port clash, said "Docker is installed but
 * the daemon is not running... Docker did not answer within 15s" while `docker info` answered in
 * 0.45 s. A probe that times out is not proof the daemon is down: it is asked once more, and if it
 * is still silent the message says Docker did not answer in time. "Not running" is kept for a
 * docker CLI that says it cannot connect.
 */
function answer(overrides: Partial<SpawnSyncReturns<string>> & Pick<SpawnSyncReturns<string>, "status">): SpawnSyncReturns<string> {
  return { stdout: "", stderr: "", pid: 0, output: ["", ""], signal: null, ...overrides }
}

const TIMED_OUT = answer({ status: null, error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }) })
const VERSION_OK = answer({ status: 0, stdout: "28.0.1" })
const INFO_OK = answer({ status: 0, stdout: "Server Version: 28.0.1" })

describe("probeDockerDaemon on a Docker that is slow to answer", () => {
  beforeEach(() => spawnSyncMock.mockReset())

  it("asks again once, and takes the second answer, asking only `docker info` again", () => {
    spawnSyncMock.mockReturnValueOnce(VERSION_OK).mockReturnValueOnce(TIMED_OUT).mockReturnValueOnce(INFO_OK)
    expect(probeDockerDaemon()).toEqual({ ok: true })
    expect(spawnSyncMock.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      ["version", "--format", "{{.Client.Version}}"],
      ["info"],
      ["info"],
    ])
  })

  it("reports a Docker silent for the whole wait as not answering, not as not running", () => {
    spawnSyncMock.mockReturnValue(TIMED_OUT)
    let now = 0
    const probe = probeDockerDaemon({ now: () => (now += 20_000) })
    expect(probe).toMatchObject({ ok: false, reason: "daemon_unresponsive" })
    expect(spawnSyncMock).toHaveBeenCalledTimes(3)
    if (probe.ok) return
    const message = formatDockerUnavailableMessage(probe)
    expect(message).not.toMatch(/not running/)
    expect(message).toMatch(/did not answer in time/)
    expect(message).toMatch(/busy/)
  })

  it("does not ask again when the docker CLI says it cannot connect", () => {
    spawnSyncMock.mockReturnValueOnce(VERSION_OK).mockReturnValueOnce(answer({ status: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" }))
    expect(probeDockerDaemon()).toMatchObject({ ok: false, reason: "daemon_unavailable" })
    expect(spawnSyncMock).toHaveBeenCalledTimes(2)
  })
})

/** A Docker whose first `info` hangs and whose second answers, as a Docker busy for a moment does. */
function busyOnce(): { runner: DockerRunner; infoCalls: () => number; versionCalls: () => number } {
  let info = 0
  let version = 0
  const runner: DockerRunner = (args) => {
    if (args[0] === "version") {
      version += 1
      return Promise.resolve<DockerAnswer>({ status: 0, stdout: "28.0.1", stderr: "", timedOut: false, missing: false })
    }
    info += 1
    if (info === 1) return new Promise<DockerAnswer>(() => undefined)
    return Promise.resolve<DockerAnswer>({ status: 0, stdout: "ok", stderr: "", timedOut: false, missing: false })
  }
  return { runner, infoCalls: () => info, versionCalls: () => version }
}

describe("probeDockerDaemonRetrying (requireDockerDaemonAsync)", () => {
  it("asks `docker info` again once after a silence, and `docker version` only the once", async () => {
    const docker = busyOnce()
    expect(await probeDockerDaemonRetrying(docker.runner, { firstAskMs: 100, askMs: 100 })).toEqual({ ok: true })
    expect(docker.infoCalls()).toBe(2)
    expect(docker.versionCalls()).toBe(1)
  })
})

describe("the message for a docker CLI that says something else", () => {
  const cases: Array<[string, RegExp]> = [
    ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", /daemon is not running/],
    ["error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.", /daemon is not running/],
    ["failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running", /daemon is not running/],
    ["permission denied while trying to reach the docker socket", /`docker info` failed/],
  ]
  it.each(cases)("%s", (detail, headline) => {
    const message = formatDockerUnavailableMessage({ ok: false, reason: "daemon_unavailable", detail })
    expect(message.split("\n")[0]).toMatch(headline)
  })

  afterAll(() => vi.restoreAllMocks())
})
