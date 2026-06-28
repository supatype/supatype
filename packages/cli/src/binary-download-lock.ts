/**
 * Coordinates concurrent component-binary downloads (postinstall, init, dev).
 * A second CLI process waits for an in-flight download instead of racing the CDN.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cachePath, type Component } from "./binary-cache.js"

const LOCK_VERSION = 1 as const
const STALE_MS = 30 * 60 * 1000
const POLL_MS = 500
const WAIT_NOTICE_MS = 3000

interface DownloadLockPayload {
  version: typeof LOCK_VERSION
  pid: number
  component: Component
  semver: string
  startedAt: string
}

function lockPath(component: Component, version: string): string {
  return join(cachePath(component, version), ".downloading")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLock(component: Component, version: string): DownloadLockPayload | null {
  const path = lockPath(component, version)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as DownloadLockPayload
    if (data.version !== LOCK_VERSION) return null
    return data
  } catch {
    return null
  }
}

function isLockStale(lock: DownloadLockPayload): boolean {
  if (!isPidAlive(lock.pid)) return true
  const age = Date.now() - Date.parse(lock.startedAt)
  return Number.isNaN(age) || age > STALE_MS
}

export function clearDownloadLock(component: Component, version: string): void {
  const path = lockPath(component, version)
  if (existsSync(path)) unlinkSync(path)
}

/** Atomically claim the download lock for this process, or return false if another live holder exists. */
export function tryAcquireDownloadLock(component: Component, version: string): boolean {
  mkdirSync(cachePath(component, version), { recursive: true })
  const existing = readLock(component, version)
  if (existing && !isLockStale(existing)) return false
  if (existing) clearDownloadLock(component, version)

  const payload: DownloadLockPayload = {
    version: LOCK_VERSION,
    pid: process.pid,
    component,
    semver: version,
    startedAt: new Date().toISOString(),
  }
  try {
    writeFileSync(lockPath(component, version), JSON.stringify(payload), { flag: "wx" })
    return true
  } catch {
    return false
  }
}

export function releaseDownloadLock(component: Component, version: string): void {
  const lock = readLock(component, version)
  if (!lock || lock.pid !== process.pid) return
  clearDownloadLock(component, version)
}

export function isDownloadInProgress(component: Component, version: string): boolean {
  const lock = readLock(component, version)
  return lock !== null && !isLockStale(lock)
}

export async function waitForComponentDownload(
  component: Component,
  version: string,
  isReady: () => boolean,
  onWait?: (component: Component) => void,
): Promise<"ready" | "failed" | "timeout"> {
  const deadline = Date.now() + STALE_MS
  let lastNotice = 0

  while (Date.now() < deadline) {
    if (isReady()) return "ready"

    const lock = readLock(component, version)
    if (!lock || isLockStale(lock)) {
      if (isReady()) return "ready"
      return "failed"
    }

    const now = Date.now()
    if (onWait && now - lastNotice >= WAIT_NOTICE_MS) {
      onWait(component)
      lastNotice = now
    }

    await sleep(POLL_MS)
  }

  return isReady() ? "ready" : "timeout"
}
