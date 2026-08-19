import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Marks a value the CLI wrote from `versions` in `supatype.config.ts`.
 *
 * Provenance, so that removing a pin from config can clean up the stale image reference it left
 * behind *without* deleting a value the operator wrote by hand. Before this, the image keys derived
 * from config were removed unconditionally on every compose run: an operator could override
 * `SUPATYPE_REALTIME_IMAGE` from `.env` and could not override `SUPATYPE_SERVER_IMAGE`, because the
 * latter is derivable from a pin and the former is not. Same file, same shape, different rules.
 */
export const MANAGED_MARKER = "# supatype:managed, value from versions in supatype.config.ts"

interface EnvLine {
  /** `KEY` for an assignment, undefined for comments and blanks. */
  key?: string
  text: string
  /** True when the preceding line is the managed marker. */
  managed: boolean
}

function parseLines(text: string): EnvLine[] {
  const out: EnvLine[] = []
  if (text === "") return out
  let markerPending = false
  // A file ending in a newline yields a final empty element; keeping it would put a blank line
  // between the existing content and anything appended.
  const raws = text.split(/\r?\n/)
  while (raws.length > 0 && raws[raws.length - 1] === "") raws.pop()
  for (const raw of raws) {
    const trimmed = raw.trim()
    if (trimmed === MANAGED_MARKER) {
      markerPending = true
      out.push({ text: raw, managed: false })
      continue
    }
    const eq = raw.indexOf("=")
    const key = eq > 0 ? raw.slice(0, eq).trim() : undefined
    const isAssignment = key !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    out.push({ ...(isAssignment && { key }), text: raw, managed: isAssignment && markerPending })
    if (!isAssignment && trimmed !== "") markerPending = false
    else if (isAssignment) markerPending = false
  }
  return out
}

export interface UpsertOptions {
  /**
   * Keys to delete: but only where the CLI wrote them (see [`MANAGED_MARKER`]). A hand-written value
   * is left alone, because the operator putting an image tag in `.env` is the documented way to run a
   * local build and deleting it silently sent them back to `:latest`.
   */
  removeManaged?: readonly string[]
  /** Keys in `updates` that come from config and may later be cleaned up. Written with the marker. */
  managed?: readonly string[]
  /** Keys to delete outright, whoever wrote them. For secrets being rotated out. */
  remove?: readonly string[]
}

/**
 * Merge key/value updates into a project `.env`.
 *
 * Comments, blank lines and ordering are preserved: this file is edited by hand, and the previous
 * implementation rebuilt it from the assignments alone, so every comment an operator had written
 * disappeared the first time they ran anything that touched `.env`.
 */
export function upsertEnvFile(
  cwd: string,
  updates: Record<string, string>,
  options: UpsertOptions | readonly string[] = {},
): void {
  // Historically the third argument was a plain list of keys to remove unconditionally.
  const opts: UpsertOptions = Array.isArray(options)
    ? { remove: options as readonly string[] }
    : (options as UpsertOptions)
  const removeManaged = new Set(opts.removeManaged ?? [])
  const removeAlways = new Set(opts.remove ?? [])
  const managed = new Set(opts.managed ?? [])

  const envPath = join(cwd, ".env")
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  const lines = parseLines(existing)

  const written = new Set<string>()
  const kept: EnvLine[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const key = line.key

    if (key === undefined) {
      kept.push(line)
      continue
    }

    if (removeAlways.has(key) || (removeManaged.has(key) && line.managed)) {
      // Drop the marker that introduced it, so no orphan comment is left behind.
      if (line.managed && kept[kept.length - 1]?.text.trim() === MANAGED_MARKER) kept.pop()
      continue
    }

    if (key in updates) {
      const wantsMarker = managed.has(key)
      if (wantsMarker && kept[kept.length - 1]?.text.trim() !== MANAGED_MARKER) {
        kept.push({ text: MANAGED_MARKER, managed: false })
      }
      if (!wantsMarker && line.managed && kept[kept.length - 1]?.text.trim() === MANAGED_MARKER) {
        kept.pop()
      }
      kept.push({ key, text: `${key}=${updates[key]}`, managed: wantsMarker })
      written.add(key)
      continue
    }

    kept.push(line)
  }

  const appended: string[] = []
  for (const [key, value] of Object.entries(updates)) {
    if (written.has(key)) continue
    if (managed.has(key)) appended.push(MANAGED_MARKER)
    appended.push(`${key}=${value}`)
  }

  const body = [...kept.map((l) => l.text), ...appended].join("\n")
  writeFileSync(envPath, `${body.replace(/\n+$/, "")}\n`, "utf8")
}

/**
 * Parse a project `.env` into key/value pairs.
 *
 * Deliberately small: `KEY=value`, `#` comments, one optional layer of surrounding quotes. No
 * interpolation and no `export` handling, because Compose's own parser does not do those either and
 * a `.env` that means two different things depending on who reads it is worse than a limited one.
 */
export function readEnvFile(cwd: string): Record<string, string> {
  const envPath = join(cwd, ".env")
  if (!existsSync(envPath)) return {}

  const out: Record<string, string> = {}
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export function readEnvValue(cwd: string, key: string, fallback: string): string {
  const envPath = join(cwd, ".env")
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"))
    if (m?.[1]) return m[1].trim()
  }
  return fallback
}

/** Whether `.env` carries a non-empty value for `key`. Distinguishes absent from defaulted. */
export function hasEnvValue(cwd: string, key: string): boolean {
  const envPath = join(cwd, ".env")
  if (!existsSync(envPath)) return false
  return new RegExp(`^${key}=(.+)$`, "m").test(readFileSync(envPath, "utf8"))
}

export function readEnvInt(cwd: string, key: string): number | null {
  const raw = readEnvValue(cwd, key, "")
  if (!raw) return null
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}
