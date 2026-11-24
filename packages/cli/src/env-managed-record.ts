/**
 * What the CLI last wrote for each managed key of an env file, so that the next write can tell a
 * value someone edited in place under the managed marker from one the CLI itself wrote.
 *
 * Kept in the project's `.supatype/` directory (gitignored: it is one developer's record). Only a
 * sha256 of each value is stored, never the value, because a managed key may be a secret (an SMTP
 * password) and the record is only ever compared against, not shown.
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { readJsonObjectFile } from "./json-file.js"

/** Key to the sha256 of the value the CLI last wrote for it, in one env file. */
export type ManagedRecord = Readonly<Record<string, string>>

function recordPath(cwd: string): string {
  return join(cwd, ".supatype", "env-managed.json")
}

/** The digest the record holds for `value`. */
export function digestValue(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Every env file's record, keyed by file name; empty when there is none or it cannot be read. */
function readAll(cwd: string): Record<string, ManagedRecord> {
  const raw = readJsonObjectFile(recordPath(cwd)) ?? {}
  const out: Record<string, ManagedRecord> = {}
  for (const [file, entries] of Object.entries(raw)) {
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) continue
    const digests: Record<string, string> = {}
    for (const [key, digest] of Object.entries(entries)) if (typeof digest === "string") digests[key] = digest
    out[file] = digests
  }
  return out
}

/** The record for `file` ("`.env`" and so on); empty before the CLI has written one. */
export function readManagedRecord(cwd: string, file: string): ManagedRecord {
  return readAll(cwd)[file] ?? {}
}

/**
 * Keep `record` for `file`. Best effort: failing to write only means a later hand edit goes
 * unreported, which is where things stood before the record existed.
 */
export function writeManagedRecord(cwd: string, file: string, record: ManagedRecord): void {
  const all = readAll(cwd)
  if (JSON.stringify(all[file] ?? {}) === JSON.stringify(record)) return
  try {
    const path = recordPath(cwd)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ ...all, [file]: record }, null, 2)}\n`)
  } catch {
    // Not worth failing a compose run over.
  }
}
