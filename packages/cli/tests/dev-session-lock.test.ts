import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  clearDevSessionLock,
  devSessionLockPath,
  readDevSessionLock,
  writeDevSessionLock,
} from "../src/dev-session-lock.js"

describe("dev-session-lock", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-lock-"))
  })

  afterEach(() => {
    clearDevSessionLock(dir)
  })

  it("writes and reads a lock file", () => {
    writeDevSessionLock(dir, {
      composeProject: "supatype-demo",
      projectRef: "demo",
      composePath: join(dir, ".supatype/self-host/docker-compose.yml"),
      kongPort: 18473,
      startedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(existsSync(devSessionLockPath(dir))).toBe(true)
    const lock = readDevSessionLock(dir)
    expect(lock?.composeProject).toBe("supatype-demo")
    expect(lock?.kongPort).toBe(18473)
  })

  it("clears the lock file", () => {
    mkdirSync(join(dir, ".supatype"), { recursive: true })
    writeFileSync(
      devSessionLockPath(dir),
      JSON.stringify({
        version: 1,
        composeProject: "supatype-demo",
        projectRef: "demo",
        composePath: "x",
        kongPort: 1,
        startedAt: "t",
      }),
      "utf8",
    )
    clearDevSessionLock(dir)
    expect(existsSync(devSessionLockPath(dir))).toBe(false)
  })
})
