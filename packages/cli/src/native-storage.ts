/**
 * Native dev's storage service: packages/storage, the code a deployment runs, on this machine with
 * its file backend, so bucket rules, size limits, accepted types, access modes, caller rules and
 * image transforms come from one codebase rather than from the server's own object store.
 *
 * The server proxies /storage/v1 to the URL in the route manifest once the service answers. When
 * it cannot be started, storage is off: /storage/v1 answers 503, and dev says why and how to fix
 * it. The server's built-in object store is never mounted, since it applies no read rules (0.9.1
 * release test: any token, the anon key included, could read or sign any object in a private bucket).
 */
import { join } from "node:path"
import { isJsonObject } from "@supatype/shared"
import { EMBEDDED_CLI_VERSION } from "./cli-version-embedded.js"
import { pushStartUndo } from "./dev-shutdown.js"
import { errorMessage } from "./error-message.js"
import { keepsObjectsLocally, OWN_BUCKET_S3_SETTINGS, serverStoreRoot } from "./local-storage.js"
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
 * How the server answers /storage/v1: by proxy to the storage service when it runs, on S3 or not.
 * With the service down, a project whose objects stay on this machine gets no storage at all, and a
 * project on S3 is left to the server's own settings (a SUPATYPE_STORAGE_URL in .env, say).
 *
 * When the service is not running, SUPATYPE_STORAGE_DISABLED has a 0.9.2 server answer 503
 * "storage service is not running". An older server ignores it, so the URL is blanked as well
 * rather than left out: unset, the server proxies to its default of http://localhost:5000,
 * whatever answers there, while blank it answers 502 "storage not configured".
 *
 * Every other storage variable is blanked, since the shell's reach the server too (ProcessManager
 * passes process.env on): a STORAGE_PROVIDER=local there would mount the built-in store.
 */
export function serverStorageEnv(storage: NativeStorage | null, config: SupatypeProjectConfig): Record<string, string> {
  if (storage === null && !keepsObjectsLocally(config)) return {}
  return {
    SUPATYPE_STORAGE_URL: storage?.url ?? "",
    SUPATYPE_STORAGE_DISABLED: storage === null ? "true" : "",
    STORAGE_PROVIDER: "",
    STORAGE_PATH: "",
  }
}

/** How long the service has to answer /health before dev turns storage off. */
const READY_TIMEOUT_MS = 60_000

/** Where the service keeps object bytes, apart from the server's object store under `storage/`. */
function nativeStorageServiceRoot(stateRoot: string): string {
  return join(stateRoot, "storage-service")
}

/** The file backend under the state directory, for a project whose objects stay on this machine. */
function fileBackendEnv(stateRoot: string): Record<string, string> {
  return { STORAGE_BACKEND: "file", STORAGE_FILE_PATH: nativeStorageServiceRoot(stateRoot) }
}

/** The environment compose gives the storage image, for a single developer on one machine. */
function storageEnv(opts: NativeStorageOptions, backend: Record<string, string>): Record<string, string> {
  return {
    DATABASE_URL: opts.databaseUrl,
    JWT_SECRET: opts.jwtSecret,
    PORT: String(opts.port),
    HOST: "127.0.0.1",
    ...backend,
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
async function startAndWait(
  launch: ComponentLaunchSpec,
  opts: NativeStorageOptions,
  url: string,
  backend: Record<string, string> = fileBackendEnv(opts.stateRoot),
): Promise<ProcessManager> {
  let exited = false
  const proc = new ProcessManager(launch.bin, launch.args, {
    label: "storage",
    pidDir: opts.pidDir,
    colour: "\x1b[34m",
    env: storageEnv(opts, backend),
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
 * started, with the manifest left pointing nowhere, so storage is off until the next start.
 */
export async function startNativeStorage(
  opts: NativeStorageOptions,
  resolveLaunch: ResolveLaunch = resolveStorageLaunch,
): Promise<NativeStorage | null> {
  const url = `http://127.0.0.1:${opts.port}`
  try {
    const proc = await startAndWait(await resolveLaunch(opts.config, opts.cwd), opts, url)
    // Until everything the server's store held is in the service, storage stays off rather than
    // answer without it; the old files stay on disk and the next start imports them again.
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
      "[supatype] ⚠  Storage is off: the storage service did not start, so /storage/v1 answers 503 " +
        "\"storage service is not running\".\n" +
        `  ${errorMessage(err)}\n` +
        "  Fix the cause above and restart `supatype dev`. Your stored files are kept and come back then.",
    )
    return null
  }
}

/**
 * The storage service's backend for a project on S3 (`storage.provider: "s3"`): the project's own
 * bucket, every Supatype bucket a prefix in it, from `env` (the shell over .env). Null when
 * SUPATYPE_STORAGE_URL names a storage service of the developer's own, which the server then proxies
 * to as .env says. Throws on a blank S3_BUCKET: the service's other defaults point at a SeaweedFS
 * native dev does not run, so starting without one would only move the failure to the first upload.
 */
export function nativeS3StorageEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> | null {
  if ((env["SUPATYPE_STORAGE_URL"] ?? "").trim() !== "") return null
  if ((env["S3_BUCKET"] ?? "").trim() === "") {
    throw new Error(
      'storage.provider is "s3", but S3_BUCKET is blank in .env. Set S3_BUCKET to the bucket this ' +
        "project keeps its files in (with S3_REGION for AWS, or S3_ENDPOINT for MinIO, R2 and the like), " +
        'or set storage.provider to "local" to keep them on this machine.',
    )
  }
  // Blank stays blank: the service reads a blank setting as unset, and it overrides any value
  // the service would otherwise inherit from dev's own environment.
  return { STORAGE_BACKEND: "s3", ...Object.fromEntries(OWN_BUCKET_S3_SETTINGS.map((key) => [key, env[key] ?? ""])) }
}

/**
 * Starts the storage service on the project's S3 bucket and records it in the route manifest.
 * Throws when it does not start: there is no store on this machine to fall back to.
 */
export async function startNativeS3Storage(
  opts: NativeStorageOptions,
  s3Env: Record<string, string>,
  resolveLaunch: ResolveLaunch = resolveStorageLaunch,
): Promise<NativeStorage> {
  const url = `http://127.0.0.1:${opts.port}`
  const bucket = s3Env["S3_BUCKET"] ?? ""
  try {
    const proc = await startAndWait(await resolveLaunch(opts.config, opts.cwd), opts, url, s3Env)
    patchRouteManifest(opts.manifestPath, { storage_url: url })
    console.log(`[supatype] Storage service: ${url} (objects in S3 bucket ${bucket})`)
    return { proc, url }
  } catch (err) {
    throw new Error(`the storage service for S3 bucket ${bucket} did not start: ${errorMessage(err)}`)
  }
}
