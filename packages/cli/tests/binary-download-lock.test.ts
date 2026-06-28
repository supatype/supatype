import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  tryAcquireDownloadLock,
  releaseDownloadLock,
  isDownloadInProgress,
  clearDownloadLock,
} from "../src/binary-download-lock.js"
import { cachePath } from "../src/binary-cache.js"

const VERSION = "9.9.9-test"

describe("binary-download-lock", () => {
  let dir: string

  beforeEach(() => {
    dir = cachePath("deno", VERSION)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    clearDownloadLock("deno", VERSION)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it("acquires and releases a download lock", () => {
    expect(tryAcquireDownloadLock("deno", VERSION)).toBe(true)
    expect(isDownloadInProgress("deno", VERSION)).toBe(true)
    releaseDownloadLock("deno", VERSION)
    expect(isDownloadInProgress("deno", VERSION)).toBe(false)
  })

  it("rejects a second acquire while the lock is held", () => {
    expect(tryAcquireDownloadLock("deno", VERSION)).toBe(true)
    expect(tryAcquireDownloadLock("deno", VERSION)).toBe(false)
    releaseDownloadLock("deno", VERSION)
  })
})
