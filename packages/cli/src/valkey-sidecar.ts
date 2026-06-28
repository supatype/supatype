/**
 * Lightweight Valkey container for native `supatype dev` (REST response cache).
 */

import { spawnSync } from "node:child_process"
import { createConnection } from "node:net"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 6379
const IMAGE = "valkey/valkey:8-alpine"

function containerName(projectName: string): string {
  const safe = projectName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48)
  return `supatype-valkey-dev-${safe}`
}

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" })
  return r.status === 0
}

function isAddrReachable(host: string, port: number, timeoutMs = 800): boolean {
  try {
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `const n=require('net');const s=n.createConnection({host:${JSON.stringify(host)},port:${port}});` +
          `s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));` +
          `setTimeout(()=>process.exit(1),${timeoutMs})`,
      ],
      { stdio: "ignore" },
    )
    return r.status === 0
  } catch {
    return false
  }
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* spin */
  }
}

export interface ValkeySidecarResult {
  addr: string
  containerName: string | null
  started: boolean
}

/**
 * Ensure Valkey is reachable at 127.0.0.1:6379 for native dev.
 * Starts a named Docker container when Docker is available and nothing is listening.
 */
export function ensureValkeySidecar(projectName: string): ValkeySidecarResult {
  const envAddr = process.env["SUPATYPE_VALKEY_ADDR"]?.trim()
  if (envAddr) {
    return { addr: envAddr, containerName: null, started: false }
  }

  const addr = `${DEFAULT_HOST}:${DEFAULT_PORT}`

  if (isAddrReachable(DEFAULT_HOST, DEFAULT_PORT)) {
    return { addr, containerName: null, started: false }
  }

  if (!dockerAvailable()) {
    console.warn(
      "[supatype] ⚠  Valkey not available (Docker not running). " +
        "REST server cache (`cache({ server: true })`) will bypass until Valkey is reachable.",
    )
    return { addr: "", containerName: null, started: false }
  }

  const name = containerName(projectName)
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" })

  const run = spawnSync(
    "docker",
    ["run", "-d", "--name", name, "-p", `${DEFAULT_PORT}:6379`, IMAGE],
    { encoding: "utf8" },
  )

  if (run.status !== 0) {
    const detail = (run.stderr || run.stdout || "").trim()
    console.warn(
      `[supatype] ⚠  Could not start Valkey sidecar: ${detail || `exit ${run.status}`}\n` +
        "  REST server cache will bypass until Valkey is available.",
    )
    return { addr: "", containerName: null, started: false }
  }

  for (let i = 0; i < 30; i++) {
    if (isAddrReachable(DEFAULT_HOST, DEFAULT_PORT)) {
      console.log(`[supatype] Valkey sidecar running (${addr})`)
      return { addr, containerName: name, started: true }
    }
    sleepMs(100)
  }

  console.warn("[supatype] ⚠  Valkey sidecar started but not reachable yet — cache may bypass initially.")
  return { addr, containerName: name, started: true }
}

export function stopValkeySidecar(containerName: string | null): void {
  if (!containerName) return
  spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" })
}

/** @internal Test helper — probe without subprocess. */
export function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host, port })
    s.once("connect", () => {
      s.destroy()
      resolve(true)
    })
    s.once("error", () => resolve(false))
    setTimeout(() => {
      s.destroy()
      resolve(false)
    }, 800)
  })
}
