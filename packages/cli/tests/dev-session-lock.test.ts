import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
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

  /**
   * On macOS the temp folder is `/var/...`, a link to `/private/var/...`, and a process's cwd comes
   * back as the real path. A lock written through one spelling of the folder must still count when
   * read through the other: it is the same project, not a copy.
   */
  it("keeps a lock written through a linked path to the same folder", () => {
    const alias = `${dir}-link`
    symlinkSync(dir, alias, "junction")
    try {
      writeDevSessionLock(alias, {
        composeProject: "supatype-demo",
        projectRef: "demo",
        composePath: join(alias, ".supatype/self-host/docker-compose.yml"),
        kongPort: 18473,
        startedAt: "2026-01-01T00:00:00.000Z",
      })
      expect(readDevSessionLock(dir)?.composeProject).toBe("supatype-demo")
      expect(readDevSessionLock(alias)?.composeProject).toBe("supatype-demo")
    } finally {
      rmSync(alias, { recursive: false, force: true })
    }
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
