import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { devSessionLockPath } from "../src/dev-session-lock.js"
import { cleanStaleNativeSession } from "../src/native-stale-session.js"
import type { DockerCaller } from "../src/valkey-sidecar.js"

const CONTAINER = "supatype-valkey-dev-demo"
const OWNER_PID = 4242

let dir: string
let docker: string[][]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-stale-session-"))
  docker = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A session file as native dev wrote it, held by `pid`. */
function writeSession(fields: Record<string, unknown>): void {
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  writeFileSync(
    devSessionLockPath(dir),
    JSON.stringify({
      version: 1,
      provider: "native",
      composeProject: "supatype-demo",
      projectRef: "demo",
      composePath: join(dir, ".supatype", "self-host", "docker-compose.yml"),
      startedAt: "2026-11-22T10:00:00.000Z",
      pid: OWNER_PID,
      ...fields,
    }),
  )
}

/** A docker that records what it was asked and removes whatever it is asked to. */
function recordingDocker(status = 0): DockerCaller {
  return async (args) => {
    docker.push([...args])
    return { status, stdout: "", stderr: "" }
  }
}

const gone = (): boolean => false
const running = (): boolean => true

describe("a stale native dev session", () => {
  it("is cleaned when its owner is gone: the Valkey container and the session file go, and one line says so", async () => {
    writeSession({ valkeyContainer: CONTAINER })

    const said = await cleanStaleNativeSession(dir, { docker: recordingDocker(), alive: gone })

    expect(docker).toEqual([["rm", "-f", CONTAINER]])
    expect(existsSync(devSessionLockPath(dir))).toBe(false)
    expect(said).toContain(String(OWNER_PID))
    expect(said).toContain(CONTAINER)
    expect(said).toContain("dev-session.json")
    expect(said?.includes("\n")).toBe(false)
  })

  it("is left alone when its owner is still running", async () => {
    writeSession({ valkeyContainer: CONTAINER })

    const said = await cleanStaleNativeSession(dir, { docker: recordingDocker(), alive: running })

    expect(said).toBeNull()
    expect(docker).toEqual([])
    expect(existsSync(devSessionLockPath(dir))).toBe(true)
  })

  it("removes only the session file when the session started no container", async () => {
    writeSession({})

    const said = await cleanStaleNativeSession(dir, { docker: recordingDocker(), alive: gone })

    expect(docker).toEqual([])
    expect(existsSync(devSessionLockPath(dir))).toBe(false)
    expect(said).toContain("dev-session.json")
    expect(said).not.toContain("Valkey")
  })

  it("says the container could not be removed when Docker refuses, and still clears the session file", async () => {
    writeSession({ valkeyContainer: CONTAINER })

    const said = await cleanStaleNativeSession(dir, { docker: recordingDocker(1), alive: gone })

    expect(existsSync(devSessionLockPath(dir))).toBe(false)
    expect(said).toContain(`docker rm -f ${CONTAINER}`)
  })

  it("does nothing when there is no session file", async () => {
    expect(await cleanStaleNativeSession(dir, { docker: recordingDocker(), alive: gone })).toBeNull()
    expect(docker).toEqual([])
  })

  it("leaves a Docker dev session to Docker dev's own recovery", async () => {
    writeSession({ provider: "docker", valkeyContainer: undefined })

    expect(await cleanStaleNativeSession(dir, { docker: recordingDocker(), alive: gone })).toBeNull()
    expect(existsSync(devSessionLockPath(dir))).toBe(true)
  })

  it("never treats this very process as a gone owner", async () => {
    writeSession({ pid: process.pid, valkeyContainer: CONTAINER })

    expect(await cleanStaleNativeSession(dir, { docker: recordingDocker(), alive: gone })).toBeNull()
    expect(docker).toEqual([])
  })
})
