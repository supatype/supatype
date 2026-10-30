/**
 * Native dev's storage service: packages/storage, the code a deployment runs, on this machine with
 * its file backend, so bucket rules, size limits, accepted types, access modes, caller rules and
 * image transforms come from one codebase rather than from the server's own object store.
 *
 * The server proxies /storage/v1 to the URL in the route manifest once the service answers. When
 * it cannot be started, the server's built-in object store answers instead, and dev says plainly
 * what that does not enforce.
 */
import { join } from "node:path"
import { isJsonObject } from "@supatype/shared"
import { EMBEDDED_CLI_VERSION } from "./cli-version-embedded.js"
import { pushStartUndo } from "./dev-shutdown.js"
import { errorMessage } from "./error-message.js"
import { keepsObjectsLocally, localStorageEnv, serverStoreRoot } from "./local-storage.js"
import { importLegacyNativeStorage } from "./native-storage-import.js"
import { ProcessManager } from "./process-manager.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { patchRouteManifest } from "./route-manifest.js"
import { resolveStorageLaunch } from "./storage-launch.js"
import type { ComponentLaunchSpec } from "./component-launch.js"

export interface NativeStorageOptions {
  config: SupatypeProjectConfig
  cwd: string
  manifestPath: string
  pidDir: string
  /** Native dev's state directory: the service keeps objects in `storage-service/` under it. */
  stateRoot: string
  port: number
  databaseUrl: string
  jwtSecret: string
}

/** A running storage service and the URL the server reaches it at. */
export interface NativeStorage {
  proc: ProcessManager
  url: string
}

type ResolveLaunch = (config: SupatypeProjectConfig, cwd: string) => Promise<ComponentLaunchSpec>

/**
 * How the server answers /storage/v1: by proxy to the storage service when it runs, else from its
 * own object store under `stateRoot` for a project whose objects stay on this machine. A project
 * on S3 sets neither.
 */
export function serverStorageEnv(
  storage: NativeStorage | null,
  config: SupatypeProjectConfig,
  stateRoot: string,
): Record<string, string> {
  if (storage !== null) return { SUPATYPE_STORAGE_URL: storage.url }
  return keepsObjectsLocally(config) ? localStorageEnv(stateRoot) : {}
}

/** How long the service has to answer /health before dev falls back to the server's store. */
const READY_TIMEOUT_MS = 60_000

/** Where the service keeps object bytes, apart from the server's object store under `storage/`. */
function nativeStorageServiceRoot(stateRoot: string): string {
  return join(stateRoot, "storage-service")
}

/** The environment compose gives the storage image, for a single developer on one machine. */
function storageEnv(opts: NativeStorageOptions): Record<string, string> {
  return {
    DATABASE_URL: opts.databaseUrl,
    JWT_SECRET: opts.jwtSecret,
    PORT: String(opts.port),
    HOST: "127.0.0.1",
    STORAGE_BACKEND: "file",
    STORAGE_FILE_PATH: nativeStorageServiceRoot(opts.stateRoot),
    // A local project has no plan, so no limits beyond each bucket's own, as self-host compose.
    PROJECT_TIER: "enterprise",
    STORAGE_QUOTA: "-1",
    TIER_MAX_UPLOAD_SIZE: "-1",
    MAX_UPLOAD_SIZE: "-1",
  }
}

/** Whether `url`/health answers `{ "status": "ok" }`, which the service does once its schema is ready. */
async function reportsReady(url: string): Promise<boolean> {
  const body: unknown = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
  return isJsonObject(body) && body["status"] === "ok"
}

/**
 * Resolves once the service reports ready; rejects when it has exited (`crashed`), which it does at
 * once when, say, sharp cannot load, rather than waiting out the timeout, or when the time is up.
 *
 * The time counted is the waiting it did: each step adds at most what an ask and a pause can
 * take, so a stretch in which something else held the event loop does not use up the wait.
 */
export async function waitForStorageReady(
  url: string,
  crashed: () => boolean,
  { timeoutMs = READY_TIMEOUT_MS, now = Date.now }: { timeoutMs?: number; now?: () => number } = {},
): Promise<void> {
  for (let waited = 0; waited < timeoutMs; ) {
    const stepStart = now()
    if (await reportsReady(url)) return
    if (crashed()) throw new Error("the storage service exited before it was ready (its output is above)")
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    waited += Math.min(now() - stepStart, READY_STEP_MAX_MS)
  }
  throw new Error(`the storage service did not report ready at ${url}/health within ${timeoutMs / 1000}s`)
}

/** How often the wait asks /health, and the most one ask and pause may count: the ask's own limit and the pause. */
const READY_POLL_MS = 250
const READY_STEP_MAX_MS = 2_000 + READY_POLL_MS

/**
 * Starts the service and waits for it; stops it again when it never becomes ready. Its stop is
 * recorded as an undo of dev's start the moment it is spawned, so a Ctrl+C while it is still
 * starting stops it too, and ends the wait.
 */
async function startAndWait(launch: ComponentLaunchSpec, opts: NativeStorageOptions, url: string): Promise<ProcessManager> {
  let exited = false
  const proc = new ProcessManager(launch.bin, launch.args, {
    label: "storage",
    pidDir: opts.pidDir,
    colour: "\x1b[34m",
    env: storageEnv(opts),
    // Called when it exits with an error, before each restart.
    beforeRestart: () => {
      exited = true
    },
  })
  proc.start()
  pushStartUndo(() => {
    exited = true
    return proc.stop()
  })
  try {
    await waitForStorageReady(url, () => exited)
    return proc
  } catch (err) {
    await proc.stop()
    throw err
  }
}

/**
 * Start the storage service for native dev, import what the server's object store holds and the
 * service does not, and record the service in the route manifest. Null when it could not be
 * started, with the manifest left pointing nowhere, so the caller falls back to the server's store.
 */
export async function startNativeStorage(
  opts: NativeStorageOptions,
  resolveLaunch: ResolveLaunch = resolveStorageLaunch,
): Promise<NativeStorage | null> {
  const url = `http://127.0.0.1:${opts.port}`
  try {
    const proc = await startAndWait(await resolveLaunch(opts.config, opts.cwd), opts, url)
    // Until everything the server's store held is in the service, the server's store keeps
    // answering, so nothing a developer stored there goes missing while an import fails.
    await importLegacyNativeStorage({ legacyRoot: serverStoreRoot(opts.stateRoot), url, jwtSecret: opts.jwtSecret, cliVersion: EMBEDDED_CLI_VERSION })
      .catch(async (err: unknown) => {
        await proc.stop()
        throw new Error(`could not import the server's object store: ${errorMessage(err)}`)
      })
    patchRouteManifest(opts.manifestPath, { storage_url: url })
    console.log(`[supatype] Storage service: ${url} (objects in ${nativeStorageServiceRoot(opts.stateRoot)})`)
    return { proc, url }
  } catch (err) {
    patchRouteManifest(opts.manifestPath, { storage_url: undefined })
    console.warn(
      "[supatype] ⚠  Storage service unavailable, so the server's built-in object store answers /storage/v1. " +
        "It does not apply image transforms or the storage rules a deployment enforces.\n" +
        `  ${errorMessage(err)}`,
    )
    return null
  }
}
