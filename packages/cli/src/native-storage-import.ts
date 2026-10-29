/**
 * Move what the server's built-in object store held into the storage service, the first time native
 * dev runs the service for a project.
 *
 * The server's store kept buckets in `<state>/storage/.supatype/buckets.json` and each object as a
 * file beside a JSON sidecar under `<bucket>/.meta/` naming it, its content type and its owner.
 * Buckets are sent on every start, since `buckets.json` is also where a push records the buckets a
 * schema declares before the service is up; one that exists already is left as it is. Objects are
 * uploaded once, through the service's own API, so they land in its tables and on its disk exactly
 * as an upload would. An object already there is kept. The import is recorded, with the CLI release
 * that made it, only when every object made it; until then the server's store keeps answering, so a
 * failed import loses nothing and the next start tries again. The old store is removed by a later
 * CLI release, never by the one that imported, so a project keeps its old files for one release.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { isArrayOf, isJsonObject, isOneOf, isShape, isString, nullable, optional, isBoolean, isNumber, type Guard } from "@supatype/shared"
import { compareVersions } from "./engine-floor.js"
import { readJsonFile } from "./json-file.js"
import { isReleaseVersion } from "./release-images.js"
import { signJwt } from "./jwt.js"
import { provisionBuckets, type BucketSpec } from "./storage-provision.js"

export interface LegacyStorageImport {
  /** The server's object store root: `<state>/storage`. */
  legacyRoot: string
  /** The storage service, as native dev reaches it. */
  url: string
  jwtSecret: string
  /** The running CLI's release version, "" for a source build (EMBEDDED_CLI_VERSION). */
  cliVersion: string
}

/** Written under the legacy root once every object is in the service. */
export const IMPORTED_MARKER = join(".supatype", "imported-to-storage-service.json")

/** A `buckets.json` row, as the server's store and native dev's push write one. */
const isBucketRow: Guard<BucketSpec> = isShape({
  id: isString,
  public: isBoolean,
  allowed_mime_types: optional(nullable(isArrayOf(isString))),
  file_size_limit: optional(nullable(isNumber)),
  access_mode: optional(nullable(isOneOf(["public", "private", "custom"] as const))),
  s3_bucket_policy: optional(nullable(isString)),
})

/** An object's sidecar, the fields the import reads. */
const isSidecar = isShape({ name: isString, content_type: optional(isString), owner: optional(isString) })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The marker: which CLI release imported the store, that the import finished, and whether the old
 * store has been removed since. Anything else in its place (an older marker, a partial or
 * unreadable file) is no marker: the import runs again, and nothing is removed.
 */
const isImportMarker = isShape({ complete: isBoolean, cli_version: isString, old_store_removed: optional(isBoolean) })
type ImportMarker = { complete: boolean; cli_version: string; old_store_removed?: boolean | undefined }

export async function importLegacyNativeStorage(job: LegacyStorageImport): Promise<void> {
  if (!existsSync(job.legacyRoot)) return
  await importBuckets(job)
  const marker = readJsonFile(join(job.legacyRoot, IMPORTED_MARKER), isImportMarker)
  if (marker?.complete !== true) {
    await importAllObjects(job)
    writeMarker(job.legacyRoot, { complete: true, cli_version: job.cliVersion })
    return
  }
  if (marker.old_store_removed !== true && oldStoreIsDue(marker.cli_version, job.cliVersion)) {
    await removeOldStore(job, marker)
  }
}

/** Uploads every object the old store holds; throws, naming the first few, when any did not make it. */
async function importAllObjects(job: LegacyStorageImport): Promise<void> {
  const failed = await importObjects(job)
  if (failed.length > 0) {
    throw new Error(`${failed.length} object(s) not imported: ${failed.slice(0, 5).join("; ")}`)
  }
}

function writeMarker(legacyRoot: string, marker: ImportMarker): void {
  const recorded = { ...marker, recorded_at: new Date().toISOString() }
  writeFileSync(join(legacyRoot, IMPORTED_MARKER), `${JSON.stringify(recorded)}\n`)
}

/**
 * Whether the old store may go: the import was made by a CLI release, and this is a later release.
 * Not a source build on either side (no version to compare), and never the release that imported,
 * so a project keeps its old files for one whole release in which to go back.
 */
export function oldStoreIsDue(importedBy: string, running: string): boolean {
  return isReleaseVersion(importedBy) && isReleaseVersion(running) && compareVersions(running, importedBy) > 0
}

/**
 * Removes the old store's buckets and buckets.json, saying what went, and records it so it happens
 * once. Objects are imported again first, so anything the server's store took while the service
 * was down since the import is in the service before its files go; when any is not, nothing goes.
 */
async function removeOldStore(job: LegacyStorageImport, marker: ImportMarker): Promise<void> {
  await importAllObjects(job)
  const removed = readdirSync(job.legacyRoot)
    .filter((entry) => entry !== ".supatype")
    .map((entry) => join(job.legacyRoot, entry))
  removed.push(join(job.legacyRoot, ".supatype", "buckets.json"))
  for (const path of removed) rmSync(path, { recursive: true, force: true })
  console.log(
    `[supatype] Removed the server's old object store, imported into the storage service by v${marker.cli_version}:\n` +
      removed.map((path) => `  ${path}`).join("\n"),
  )
  writeMarker(job.legacyRoot, { ...marker, old_store_removed: true })
}

/** Every bucket `buckets.json` names, created in the service unless it is there already. */
async function importBuckets(job: LegacyStorageImport): Promise<void> {
  const rows: unknown[] = readJsonFile(join(job.legacyRoot, ".supatype", "buckets.json"), isArrayOf(isJsonObject)) ?? []
  const buckets = rows.filter(isBucketRow)
  if (buckets.length === 0) return
  const failed = await provisionBuckets(job.url, serviceToken(job.jwtSecret, undefined), buckets)
  if (failed.length > 0) throw new Error(`bucket(s) not created in the storage service: ${failed.join(", ")}`)
}

/** A service-role token, carrying the object's owner as its subject when it has one. */
function serviceToken(secret: string, owner: string | undefined): string {
  const now = Math.floor(Date.now() / 1000)
  const sub = owner !== undefined && UUID.test(owner) ? { sub: owner } : {}
  return signJwt({ iss: "supatype", role: "service_role", iat: now, exp: now + 3600, ...sub }, secret)
}

/** One stored object: its bucket, its name, its bytes' path, and its sidecar. */
interface LegacyObject {
  bucket: string
  name: string
  file: string
  contentType: string
  owner: string | undefined
}

/** Uploads every object the store holds; the ones that failed, each with why. */
async function importObjects(job: LegacyStorageImport): Promise<string[]> {
  const failed: string[] = []
  for (const object of legacyObjects(job.legacyRoot)) {
    const why = await uploadObject(job, object)
    if (why !== null) failed.push(`${object.bucket}/${object.name}: ${why}`)
  }
  return failed
}

/** Every object in every bucket under `root`, found by its sidecar. */
function legacyObjects(root: string): LegacyObject[] {
  const buckets = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== ".supatype")
  return buckets.flatMap((bucket) => bucketObjects(root, bucket.name))
}

function bucketObjects(root: string, bucket: string): LegacyObject[] {
  const metaRoot = join(root, bucket, ".meta")
  if (!existsSync(metaRoot)) return []
  return readdirSync(metaRoot, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .flatMap((e) => {
      const metaPath = join(e.parentPath, e.name)
      const sidecar = readJsonFile(metaPath, isSidecar)
      if (sidecar === undefined) return []
      const file = join(root, bucket, relative(metaRoot, metaPath).replace(/\.json$/, ""))
      const contentType = sidecar.content_type ?? "application/octet-stream"
      return existsSync(file) ? [{ bucket, name: sidecar.name, file, contentType, owner: sidecar.owner }] : []
    })
}

/** Null when the object is in the service (uploaded now, or there already), else why it is not. */
async function uploadObject(job: LegacyStorageImport, object: LegacyObject): Promise<string | null> {
  const path = object.name.split("/").map(encodeURIComponent).join("/")
  const res = await fetch(`${job.url}/object/${encodeURIComponent(object.bucket)}/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${serviceToken(job.jwtSecret, object.owner)}`, "content-type": object.contentType },
    body: readFileSync(object.file),
  }).catch((err: unknown) => err)
  if (!(res instanceof Response)) return res instanceof Error ? res.message : String(res)
  if (res.ok || res.status === 409) return null
  return `${res.status} ${await res.text().catch(() => "")}`.trim()
}
