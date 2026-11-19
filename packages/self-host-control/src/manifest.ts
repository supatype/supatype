/**
 * The stack's `.supatype/manifest.json`, which the server watches and routes read and write: read
 * whole and checked, changed in memory, and written back whole and atomically, since the worker and
 * the server read it while a route may be rewriting it.
 */
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname } from "node:path"
import { parseJsonObject } from "@supatype/shared"
import { fileUnder, writeRoot, type DeployFile } from "./deploy-files.js"
import { HttpError } from "./http.js"
import { manifestPath } from "./worker.js"

/** The stack's manifest, which has to be there and be a JSON object before anything is written. */
export function readManifest(): Record<string, unknown> {
  if (!existsSync(manifestPath())) {
    throw new HttpError(409, "conflict", "The stack has no .supatype/manifest.json; run `supatype self-host compose up` first")
  }
  const parsed = parseJsonObject(readFileSync(manifestPath(), "utf8"))
  if (!parsed.ok) throw new HttpError(409, "conflict", ".supatype/manifest.json is not a JSON object")
  return parsed.value
}

/**
 * The manifest as the file a route writes, checked like every other (deploy-files.ts), and written
 * whole: the worker and the server read it while a route may be rewriting it.
 */
export function manifestFile(manifest: Record<string, unknown>): DeployFile {
  const root = writeRoot(dirname(manifestPath()), "The stack's .supatype", { mayBeLink: true })
  return { atomic: true, ...fileUnder(root, basename(manifestPath()), `${JSON.stringify(manifest, null, 2)}\n`) }
}

/**
 * Set `key` to `map`, or take it out when `map` is empty. True when the manifest changed: a key that
 * already holds the same map, or is absent for an empty one, is left as it is and not rewritten.
 */
export function setManifestKey(manifest: Record<string, unknown>, key: string, map: Readonly<Record<string, unknown>>): boolean {
  if (JSON.stringify(map) === JSON.stringify(manifest[key] ?? {})) return false
  if (Object.keys(map).length === 0) delete manifest[key]
  else manifest[key] = map
  return true
}
