/**
 * Move what the server's built-in object store holds into the storage service, on every start of
 * native dev's service for a project.
 *
 * The server's store kept buckets in `<state>/storage/.supatype/buckets.json` and each object as a
 * file beside a JSON sidecar under `<bucket>/.meta/` naming it, its content type and its owner.
 * Buckets are sent on every start, since `buckets.json` is also where a push records the buckets a
 * schema declares before the service is up; one that exists already is left as it is.
 *
 * Objects go through the service's own API, so they land in its tables and on its disk exactly as
 * an upload would. The first import sends every one, and keeps any the service holds already.
 * Each later start sends only those whose file or sidecar changed since the last import, over the
 * service's copy: native dev falls back to the server's store whenever the service fails to start,
 * and what it takes then must reach the service once it is back, while an object deleted in the
 * service since it was imported must not come back. The old files stay.
 *
 * An object the service refuses (its bucket's type or size rule, say) is skipped, named in one
 * warning and in the marker, and not sent again until its file changes. Only a failure of the
 * service itself (no answer, or a 5xx) fails the import, which records nothing, so the server's
 * store keeps answering and the next start tries again. The old store is removed by a later CLI
 * release than the one that first imported, so a project keeps its old files for one release.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { isArrayOf, isJsonObject, isOneOf, isShape, isString, nullable, optional, isBoolean, isNumber, pathInside, type Guard } from "@supatype/shared"
import { compareVersions } from "./engine-floor.js"
import { readJsonFile } from "./json-file.js"
import { isReleaseVersion } from "./release-images.js"
import { signJwt } from "./jwt.js"
import { createBucket, postToStorage, type BucketSpec, type StorageWrite } from "./storage-provision.js"

export interface LegacyStorageImport {
  /** The server's object store root: `<state>/storage`. */
  legacyRoot: string
  /** The storage service, as native dev reaches it. */
  url: string
  jwtSecret: string
  /** The running CLI's release version, "" for a source build (EMBEDDED_CLI_VERSION). */
  cliVersion: string
}

/** Written under the legacy root once every object is in the service, and again after each import. */
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

/** Something the service refused: an object as `bucket/name`, or a bucket by id, and the status. */
const isSkip = isShape({ id: isString, status: isNumber })
type Skip = typeof isSkip extends Guard<infer T> ? T : never

/**
 * The marker: which CLI release first imported the store, that the import finished, when the last
 * import started, which CLI made it and how many objects it uploaded, what the service refused, and
 * whether the old store has been removed since. Anything else in its place (an older marker, a
 * partial or unreadable file) is no marker: everything is sent again and nothing is removed. A
 * marker from before `last_import_at` dates the last import by `recorded_at`, written as it finished.
 */
const isImportMarker = isShape({
  complete: isBoolean,
  /** The release that first imported the store: the old store goes one release after it. */
  cli_version: isString,
  old_store_removed: optional(isBoolean),
  last_import_at: optional(isString),
  last_import_cli_version: optional(isString),
  last_import_objects: optional(isNumber),
  recorded_at: optional(isString),
  /** Objects the service refused, not sent again until their file changes. */
  skipped: optional(isArrayOf(isSkip)),
  /** Buckets the service refused on the last import; their objects were refused with them. */
  skipped_buckets: optional(isArrayOf(isSkip)),
})
type ImportMarker = typeof isImportMarker extends Guard<infer T> ? T : never

export async function importLegacyNativeStorage(job: LegacyStorageImport): Promise<void> {
  if (!existsSync(job.legacyRoot)) return
  const refusedBuckets = await importBuckets(job)
  const read = readJsonFile(join(job.legacyRoot, IMPORTED_MARKER), isImportMarker)
  const prior = read?.complete === true ? read : undefined
  const startedAt = new Date().toISOString()
  // A bucket refused before and taken now: its objects were refused with it, so they go again.
  const refusedNow = new Set(refusedBuckets.map((skip) => skip.id))
  const taken = new Set((prior?.skipped_buckets ?? []).map((skip) => skip.id).filter((id) => !refusedNow.has(id)))
  const due = dueObjects(prior === undefined ? null : lastImportTime(prior), taken)
  const { sent, uploaded, skipped } = await importChangedObjects(job, due, prior !== undefined)
  const marker: ImportMarker = {
    ...(prior ?? { complete: true, cli_version: job.cliVersion }),
    last_import_at: startedAt,
    last_import_cli_version: job.cliVersion,
    last_import_objects: uploaded,
    skipped: mergeSkipped(prior?.skipped ?? [], sent, skipped),
    skipped_buckets: refusedBuckets,
  }
  writeMarker(job.legacyRoot, marker)
  if (prior !== undefined && prior.old_store_removed !== true && oldStoreIsDue(prior.cli_version, job.cliVersion)) {
    removeOldStore(job.legacyRoot, marker)
  }
}

/** When the last import started, in milliseconds, or null to send everything. */
function lastImportTime(marker: ImportMarker): number | null {
  const at = Date.parse(marker.last_import_at ?? marker.recorded_at ?? "")
  return Number.isNaN(at) ? null : at
}

/** Which objects a start sends: all when `since` is null, else those changed since, and every one of a bucket in `again`. */
type DueCheck = (bucket: string, changedAt: number) => boolean

function dueObjects(since: number | null, again: ReadonlySet<string>): DueCheck {
  return (bucket, changedAt) => since === null || changedAt > since || again.has(bucket)
}

/** The skips recorded before, less any object sent again now, with the skips made now. */
function mergeSkipped(before: readonly Skip[], sent: readonly string[], now: readonly Skip[]): Skip[] {
  const retried = new Set(sent)
  return [...before.filter((skip) => !retried.has(skip.id)), ...now]
}

/** Skips as one line names them: `id (status)`. */
function describeSkips(skips: readonly Skip[]): string {
  return skips.map((skip) => `${skip.id} (${skip.status})`).join(", ")
}

/**
 * Sends each object `due` says, over the service's copy when `overwrite`, and says how many went and
 * which the service refused, those in one warning. Throws, naming the first few, when the service
 * itself failed for any.
 */
async function importChangedObjects(job: LegacyStorageImport, due: DueCheck, overwrite: boolean): Promise<ImportOutcome> {
  const outcome = await importObjects(job, due, overwrite)
  const { skipped, failed } = outcome
  if (failed.length > 0) {
    throw new Error(`${failed.length} object(s) not imported: ${failed.slice(0, 5).join("; ")}`)
  }
  if (skipped.length > 0) {
    console.warn(
      `[supatype] ⚠  The storage service refused ${skipped.length} object(s) of the server's old store, ` +
        `left there and not sent again until changed: ${describeSkips(skipped)}`,
    )
  }
  return outcome
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
 * Removes the old store's buckets and buckets.json, saying what went, and records it in `marker`,
 * the one just written, so it happens once. Called only after an import on this start sent
 * everything that changed since the last. The objects the service refused were never imported, so
 * their files and sidecars are kept, and one line says how many and where. So are the buckets.json
 * rows of the buckets it refused, so a later import can still create them.
 */
function removeOldStore(legacyRoot: string, marker: ImportMarker): void {
  const kept = skippedObjects(legacyRoot, marker.skipped ?? [])
  const keep = new Set(kept.flatMap((object) => object.paths))
  const removed = readdirSync(legacyRoot)
    .filter((entry) => entry !== ".supatype")
    .flatMap((entry) => removeUnkept(join(legacyRoot, entry), keep))
  const bucketsFile = join(legacyRoot, ".supatype", "buckets.json")
  if (keepRefusedBucketRows(bucketsFile, marker.skipped_buckets ?? [])) removed.push(bucketsFile)
  console.log(
    `[supatype] Removed the server's old object store, imported into the storage service by v${marker.cli_version}:\n` +
      removed.map((path) => `  ${path}`).join("\n"),
  )
  if (kept.length > 0) {
    const names = kept.map((object) => object.id).join(", ")
    console.log(`[supatype] Kept ${kept.length} object(s) the storage service refused, in ${legacyRoot}: ${names}`)
  }
  writeMarker(legacyRoot, { ...marker, old_store_removed: true })
}

/**
 * Rewrites buckets.json with only the rows of the `refused` buckets, or removes it when there are
 * none; true when it was removed.
 */
function keepRefusedBucketRows(bucketsFile: string, refused: readonly Skip[]): boolean {
  const ids = new Set(refused.map((skip) => skip.id))
  const rows = (readJsonFile(bucketsFile, isArrayOf(isJsonObject)) ?? []).filter((row) => ids.has(String(row["id"])))
  if (rows.length > 0) {
    writeFileSync(bucketsFile, `${JSON.stringify(rows, null, 2)}\n`)
    return false
  }
  rmSync(bucketsFile, { force: true })
  return true
}

/** The skipped objects still in the old store: each one's id and its file and sidecar. */
function skippedObjects(root: string, skipped: readonly Skip[]): { id: string; paths: string[] }[] {
  return skipped.flatMap(({ id }) => {
    const [bucket = "", ...name] = id.split("/")
    const file = join(root, bucket, ...name)
    const sidecar = `${join(root, bucket, ".meta", ...name)}.json`
    return bucket !== "" && name.length > 0 && existsSync(file) ? [{ id, paths: [file, sidecar] }] : []
  })
}

/** Removes `path` but the paths in `keep` under it, whole folders where it can, and says what went. */
function removeUnkept(path: string, keep: ReadonlySet<string>): string[] {
  if (keep.has(path)) return []
  if (![...keep].some((kept) => pathInside(path, kept))) {
    rmSync(path, { recursive: true, force: true })
    return [path]
  }
  return readdirSync(path).flatMap((entry) => removeUnkept(join(path, entry), keep))
}

/**
 * Every bucket `buckets.json` names, created in the service unless it is there already, and the
 * ones it refused. A refused bucket is named in one warning; its objects are then refused in turn,
 * so they are skipped and kept. Throws when the service itself failed for any.
 */
async function importBuckets(job: LegacyStorageImport): Promise<Skip[]> {
  const rows: unknown[] = readJsonFile(join(job.legacyRoot, ".supatype", "buckets.json"), isArrayOf(isJsonObject)) ?? []
  const refused: Skip[] = []
  const failed: string[] = []
  for (const bucket of rows.filter(isBucketRow)) {
    const write = await createBucket(job.url, serviceToken(job.jwtSecret, undefined), bucket)
    if (write.kind === "refused") refused.push({ id: bucket.id, status: write.status })
    else if (write.kind === "failed") failed.push(`${bucket.id}: ${write.text}`)
  }
  if (failed.length > 0) throw new Error(`bucket(s) not created in the storage service: ${failed.join("; ")}`)
  if (refused.length > 0) {
    console.warn(`[supatype] ⚠  The storage service refused ${refused.length} bucket(s) of the server's old store, left there: ${describeSkips(refused)}`)
  }
  return refused
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

/** What one import did: the objects it sent, how many went, which were refused, and which failed and why. */
interface ImportOutcome {
  sent: string[]
  uploaded: number
  skipped: Skip[]
  failed: string[]
}

/** Sends each object `due` says, saying what became of each. */
async function importObjects(job: LegacyStorageImport, due: DueCheck, overwrite: boolean): Promise<ImportOutcome> {
  const result: ImportOutcome = { sent: [], uploaded: 0, skipped: [], failed: [] }
  for (const object of legacyObjects(job.legacyRoot, due)) {
    const write = await uploadObject(job, object, overwrite)
    const id = `${object.bucket}/${object.name}`
    result.sent.push(id)
    if (write.kind === "created") result.uploaded++
    else if (write.kind === "refused") result.skipped.push({ id, status: write.status })
    else if (write.kind === "failed") result.failed.push(`${id}: ${write.text}`)
  }
  return result
}

/** The objects `due` says, in every bucket under `root`, found by their sidecars. */
function legacyObjects(root: string, due: DueCheck): LegacyObject[] {
  const buckets = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== ".supatype")
  return buckets.flatMap((bucket) => bucketObjects(root, bucket.name, due))
}

/**
 * The bucket's objects `due` says. File and sidecar are looked at first, so the sidecar of an
 * object unchanged since the last import is never read.
 */
function bucketObjects(root: string, bucket: string, due: DueCheck): LegacyObject[] {
  const metaRoot = join(root, bucket, ".meta")
  if (!existsSync(metaRoot)) return []
  return readdirSync(metaRoot, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .flatMap((e) => {
      const metaPath = join(e.parentPath, e.name)
      const file = join(root, bucket, relative(metaRoot, metaPath).replace(/\.json$/, ""))
      if (!existsSync(file) || !due(bucket, Math.max(statSync(file).mtimeMs, statSync(metaPath).mtimeMs))) return []
      const sidecar = readJsonFile(metaPath, isSidecar)
      if (sidecar === undefined) return []
      const contentType = sidecar.content_type ?? "application/octet-stream"
      return [{ bucket, name: sidecar.name, file, contentType, owner: sidecar.owner }]
    })
}

/**
 * Sends one object. `overwrite` replaces the service's copy, for a file changed since the last
 * import; without it, the first import keeps a copy the service holds already (409).
 */
function uploadObject(job: LegacyStorageImport, object: LegacyObject, overwrite: boolean): Promise<StorageWrite> {
  const path = object.name.split("/").map(encodeURIComponent).join("/")
  const headers: Record<string, string> = {
    authorization: `Bearer ${serviceToken(job.jwtSecret, object.owner)}`,
    "content-type": object.contentType,
    ...(overwrite && { "x-upsert": "true" }),
  }
  return postToStorage(`${job.url}/object/${encodeURIComponent(object.bucket)}/${path}`, headers, readFileSync(object.file))
}
