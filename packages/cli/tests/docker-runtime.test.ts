import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from "vitest"
import type { SpawnSyncReturns } from "node:child_process"

const spawnSyncMock = vi.hoisted(() => vi.fn())
const isInteractiveMock = vi.hoisted(() => vi.fn(() => false))
const clackLogErrorMock = vi.hoisted(() => vi.fn())
const clackNoteMock = vi.hoisted(() => vi.fn())
const clackIntroMock = vi.hoisted(() => vi.fn())
const printLogoMock = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}))

vi.mock("../src/ui/interactive.js", () => ({
  isInteractive: isInteractiveMock,
}))

vi.mock("@clack/prompts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@clack/prompts")>()
  return {
    ...original,
    intro: clackIntroMock,
    note: clackNoteMock,
    log: {
      ...original.log,
      error: clackLogErrorMock,
    },
  }
})

vi.mock("../src/ui/prompts.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/ui/prompts.js")>()
  return {
    ...original,
    printLogo: printLogoMock,
  }
})

import {
  probeDockerDaemon,
  reportDockerUnavailable,
  requireDockerDaemon,
} from "../src/docker-runtime.js"

function spawnResult(
  overrides: Partial<SpawnSyncReturns<string>> & Pick<SpawnSyncReturns<string>, "status">,
): SpawnSyncReturns<string> {
  return {
    stdout: "",
    stderr: "",
    pid: 0,
    output: ["", ""],
    signal: null,
    ...overrides,
  }
}

describe("probeDockerDaemon", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset()
  })

  it("returns ok when docker version and info succeed", () => {
    spawnSyncMock
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "24.0.0" }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "Server Version: 24.0.0" }))

    expect(probeDockerDaemon()).toEqual({ ok: true })
    expect(spawnSyncMock).toHaveBeenCalledTimes(2)
    expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual(["version", "--format", "{{.Client.Version}}"])
    expect(spawnSyncMock.mock.calls[1]?.[1]).toEqual(["info"])
  })

  it("returns cli_missing when docker is not on PATH", () => {
    spawnSyncMock.mockReturnValueOnce(
      spawnResult({ status: 1, error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) }),
    )

    expect(probeDockerDaemon()).toEqual({ ok: false, reason: "cli_missing" })
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
  })

  it("returns daemon_unavailable when info fails", () => {
    spawnSyncMock
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "24.0.0" }))
      .mockReturnValueOnce(
        spawnResult({
          status: 1,
          stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        }),
      )

    expect(probeDockerDaemon()).toEqual({
      ok: false,
      reason: "daemon_unavailable",
      detail: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    })
  })

  it("returns daemon_unavailable when version exits non-zero but client version is present (e.g. Docker paused)", () => {
    spawnSyncMock.mockReturnValueOnce(
      spawnResult({
        status: 1,
        stdout: "29.4.0\n",
        stderr: "Error response from daemon: Docker Desktop is manually paused.",
      }),
    )

    expect(probeDockerDaemon()).toEqual({
      ok: false,
      reason: "daemon_unavailable",
      detail: "Error response from daemon: Docker Desktop is manually paused.",
    })
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
  })
})

describe("reportDockerUnavailable", () => {
  const errorMock = vi.spyOn(console, "error").mockImplementation(() => {})
  const logMock = vi.spyOn(console, "log").mockImplementation(() => {})

  beforeEach(() => {
    isInteractiveMock.mockReturnValue(false)
    errorMock.mockClear()
    logMock.mockClear()
    clackLogErrorMock.mockClear()
    clackNoteMock.mockClear()
    clackIntroMock.mockClear()
    printLogoMock.mockClear()
  })

  afterAll(() => {
    errorMock.mockRestore()
    logMock.mockRestore()
  })

  it("uses [supatype] prefix on the headline via error()", () => {
    reportDockerUnavailable({
      ok: false,
      reason: "daemon_unavailable",
      detail: "Cannot connect to the Docker daemon",
    })

    expect(errorMock).toHaveBeenCalledWith(
      "[supatype] Docker is installed but the daemon is not running.",
    )
    expect(logMock.mock.calls.some((call) => String(call[0]).includes('provider: "native"'))).toBe(true)
    expect(logMock.mock.calls.some((call) => String(call[0]).includes("docker: Cannot connect"))).toBe(
      false,
    )
  })

  it("mentions unpause when daemon detail says paused", () => {
    reportDockerUnavailable({
      ok: false,
      reason: "daemon_unavailable",
      detail: "Error response from daemon: Docker Desktop is manually paused.",
    })

    expect(logMock.mock.calls.some((call) => String(call[0]).includes("Unpause Docker Desktop"))).toBe(
      true,
    )
    expect(logMock.mock.calls.some((call) => String(call[0]).includes("docker:"))).toBe(false)
  })

  it("mentions install for cli_missing", () => {
    reportDockerUnavailable({ ok: false, reason: "cli_missing" })

    expect(errorMock).toHaveBeenCalledWith("[supatype] Docker is not installed or not on your PATH.")
    expect(logMock.mock.calls.some((call) => String(call[0]).includes("docker-desktop"))).toBe(true)
  })

  it("uses Clack log + note in interactive mode", () => {
    isInteractiveMock.mockReturnValue(true)

    reportDockerUnavailable(
      {
        ok: false,
        reason: "daemon_unavailable",
        detail: "Error response from daemon: Docker Desktop is manually paused.",
      },
      { brand: { intro: "Local development" } },
    )

    expect(printLogoMock).toHaveBeenCalled()
    expect(clackIntroMock).toHaveBeenCalledWith("Local development")
    expect(clackLogErrorMock).toHaveBeenCalledWith(
      "Docker is installed but the daemon is not running.",
    )
    expect(clackNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("Unpause Docker Desktop"),
    )
    expect(errorMock).not.toHaveBeenCalled()
    expect(logMock).not.toHaveBeenCalled()
  })
})

describe("requireDockerDaemon", () => {
  let exitMock: ReturnType<typeof vi.spyOn<typeof process, "exit">>
  let errorMock: ReturnType<typeof vi.spyOn<typeof console, "error">>

  beforeEach(() => {
    spawnSyncMock.mockReset()
    isInteractiveMock.mockReturnValue(false)
    exitMock = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit)
    errorMock = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    exitMock.mockRestore()
    errorMock.mockRestore()
  })

  it("exits when the daemon is unavailable", () => {
    spawnSyncMock
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "24.0.0" }))
      .mockReturnValueOnce(spawnResult({ status: 1, stderr: "daemon down" }))

    requireDockerDaemon()

    expect(errorMock).toHaveBeenCalled()
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it("does not exit when docker is available", () => {
    spawnSyncMock
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "24.0.0" }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "ok" }))

    requireDockerDaemon()

    expect(exitMock).not.toHaveBeenCalled()
    expect(errorMock).not.toHaveBeenCalled()
  })
})
