/**
 * Lightweight Valkey container for native `supatype dev` (REST response cache).
 */

import { createConnection } from "node:net"
import { setTimeout as sleep } from "node:timers/promises"
import { askDocker, DOCKER_PULL_TIMEOUT_MS, DOCKER_QUERY_TIMEOUT_MS } from "./docker-exec.js"
import { spawnFailureText } from "./error-message.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 6379
const IMAGE = "valkey/valkey:8-alpine"

function containerName(projectName: string): string {
  const safe = projectName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48)
  return `supatype-valkey-dev-${safe}`
}

async function dockerAvailable(): Promise<boolean> {
  return (await askDocker(["info"], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })).status === 0
}

export interface ValkeySidecarResult {
  addr: string
  containerName: string | null
  started: boolean
}

const NO_VALKEY: ValkeySidecarResult = { addr: "", containerName: null, started: false }

/**
 * Ensure Valkey is reachable at 127.0.0.1:6379 for native dev.
 * Starts a named Docker container when Docker is available and nothing is listening.
 */
export async function ensureValkeySidecar(projectName: string): Promise<ValkeySidecarResult> {
  const envAddr = process.env["SUPATYPE_VALKEY_ADDR"]?.trim()
  if (envAddr) {
    return { addr: envAddr, containerName: null, started: false }
  }

  const addr = `${DEFAULT_HOST}:${DEFAULT_PORT}`

  if (await probeTcp(DEFAULT_HOST, DEFAULT_PORT)) {
    return { addr, containerName: null, started: false }
  }

  if (!(await dockerAvailable())) {
    console.warn(
      "[supatype] ⚠  Valkey not available (Docker not running). " +
        "REST server cache (`cache({ server: true })`) will bypass until Valkey is reachable.",
    )
    return NO_VALKEY
  }

  const name = containerName(projectName)
  return (await startContainer(name)) ? await awaitReachable(addr, name) : NO_VALKEY
}

/** Start the container, replacing any left from an earlier session; false, having said why, when it would not start. */
async function startContainer(name: string): Promise<boolean> {
  await askDocker(["rm", "-f", name], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })
  // `run` pulls the image first when this machine does not have it.
  const run = await askDocker(["run", "-d", "--name", name, "-p", `${DEFAULT_PORT}:6379`, IMAGE], { timeoutMs: DOCKER_PULL_TIMEOUT_MS })
  if (run.status === 0) return true
  console.warn(
    `[supatype] ⚠  Could not start Valkey sidecar: ${spawnFailureText(run)}\n` +
      "  REST server cache will bypass until Valkey is available.",
  )
  return false
}

/** Wait up to three seconds for the started container to accept connections. */
async function awaitReachable(addr: string, name: string): Promise<ValkeySidecarResult> {
  for (let i = 0; i < 30; i++) {
    if (await probeTcp(DEFAULT_HOST, DEFAULT_PORT)) {
      console.log(`[supatype] Valkey sidecar running (${addr})`)
      return { addr, containerName: name, started: true }
    }
    await sleep(100)
  }
  console.warn("[supatype] ⚠  Valkey sidecar started but not reachable yet, cache may bypass initially.")
  return { addr, containerName: name, started: true }
}

export async function stopValkeySidecar(containerName: string | null): Promise<void> {
  if (!containerName) return
  await askDocker(["rm", "-f", containerName], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })
}

/** Whether something accepts connections at `host:port`, within 800ms. */
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
