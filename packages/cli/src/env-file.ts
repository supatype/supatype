import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Marks a value the CLI wrote from `supatype.config.ts`: an image pin from `versions`, or
 * `SUPATYPE_MAILER_AUTOCONFIRM` from `auth.email.enableConfirmations`.
 *
 * Provenance, so that removing a pin from config can clean up the stale image reference it left
 * behind *without* deleting a value the operator wrote by hand. Before this, the image keys derived
 * from config were removed unconditionally on every compose run: an operator could override
 * `SUPATYPE_REALTIME_IMAGE` from `.env` and could not override `SUPATYPE_SERVER_IMAGE`, because the
 * latter is derivable from a pin and the former is not. Same file, same shape, different rules.
 */
export const MANAGED_MARKER = "# supatype:managed, value from supatype.config.ts"

/** The marker's wording when it only ever introduced image pins, still in `.env` files it wrote. */
const LEGACY_MANAGED_MARKER = "# supatype:managed, value from versions in supatype.config.ts"

function isMarker(text: string | undefined): boolean {
  const trimmed = text?.trim()
  return trimmed === MANAGED_MARKER || trimmed === LEGACY_MANAGED_MARKER
}

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
    if (isMarker(trimmed)) {
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

/** The older form of `upsertEnvFile`'s options: a list of keys, where options are an object. */
function isKeyList(options: UpsertOptions | readonly string[]): options is readonly string[] {
  return Array.isArray(options)
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
  const opts: UpsertOptions = isKeyList(options) ? { remove: options } : options
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
      if (line.managed && isMarker(kept[kept.length - 1]?.text)) kept.pop()
      continue
    }

    if (key in updates) {
      const wantsMarker = managed.has(key)
      if (wantsMarker && !isMarker(kept[kept.length - 1]?.text)) {
        kept.push({ text: MANAGED_MARKER, managed: false })
      }
      if (!wantsMarker && line.managed && isMarker(kept[kept.length - 1]?.text)) {
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
  const next = `${body.replace(/\n+$/, "")}\n`
  // Not written when nothing changed. `.env` is compose's input, and a command that only read the
  // stack (push or doctor with dev running) has no business touching it.
  if (next === existing.replace(/\r\n/g, "\n")) return
  writeFileSync(envPath, next, "utf8")
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

/**
 * `.env`'s text, or null when there is none, without the byte order mark Windows tools write.
 * Left in, it hid the first key from the `^KEY=` matches below.
 */
function envText(cwd: string): string | null {
  const envPath = join(cwd, ".env")
  return existsSync(envPath) ? readFileSync(envPath, "utf8").replace(/^\uFEFF/, "") : null
}

export function readEnvValue(cwd: string, key: string, fallback: string): string {
  const m = envText(cwd)?.match(new RegExp(`^${key}=(.+)$`, "m"))
  return m?.[1] ? m[1].trim() : fallback
}

/** Whether `.env` carries a non-empty value for `key`. Distinguishes absent from defaulted. */
export function hasEnvValue(cwd: string, key: string): boolean {
  const text = envText(cwd)
  return text !== null && new RegExp(`^${key}=(.+)$`, "m").test(text)
}

/**
 * Who wrote `key` in `.env`: "cli" when it carries [`MANAGED_MARKER`], "operator" when it does not,
 * or null when `.env` has no such key.
 */
export function envValueOwner(cwd: string, key: string): "cli" | "operator" | null {
  const text = envText(cwd)
  // The last assignment, as compose reads it.
  const line = text === null ? undefined : parseLines(text).filter((l) => l.key === key).pop()
  if (line === undefined) return null
  return line.managed ? "cli" : "operator"
}

export function readEnvInt(cwd: string, key: string): number | null {
  return portNumber(readEnvValue(cwd, key, ""))
}

/**
 * A port as `docker compose --env-file .env` resolves it: the caller's environment first, then
 * `.env`. The CLI waits on the port compose binds, so it has to read it the way compose does: an
 * exported SUPATYPE_KONG_PORT used to be bound by compose while dev and push waited on the one in
 * `.env`.
 */
export function readComposeEnvInt(cwd: string, key: string): number | null {
  const shell = process.env[key]?.trim()
  return shell ? portNumber(shell) : readEnvInt(cwd, key)
}

function portNumber(raw: string): number | null {
  if (!raw) return null
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}
