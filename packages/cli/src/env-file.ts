import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseEnvText, splitAssignment } from "./dotenv-parse.js"
import { assertEnvValues } from "./env-value.js"

export { parseEnvText }

/**
 * Marks a value the CLI wrote from `supatype.config.ts`: an image pin from `versions`, or a mailer
 * setting from `email`. (`SUPATYPE_MAILER_AUTOCONFIRM` from `auth.email.enableConfirmations` was
 * one until FF7; mailer-autoconfirm.ts takes that line out.)
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

/**
 * The label above a `DATABASE_URL` the CLI owns. Not a value copied from the config, as
 * {@link MANAGED_MARKER} says of the rest: the CLI builds the URL from the provider and port the
 * config gives and the POSTGRES_ values `init` writes beneath it, and rebuilds it when they change.
 */
export const DATABASE_URL_MARKER = "# supatype:managed, built from supatype.config.ts and the POSTGRES_ values below"

/** Every label that marks a value as the CLI's, older wordings included. */
const MARKERS: ReadonlySet<string> = new Set([MANAGED_MARKER, LEGACY_MANAGED_MARKER, DATABASE_URL_MARKER])

/** Whether `text` is one of the labels the CLI writes above a value it owns. */
export function isMarker(text: string | undefined): boolean {
  return MARKERS.has(text?.trim() ?? "")
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
    const key = splitAssignment(raw)?.key
    const isAssignment = key !== undefined
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
  /** The marker the `managed` keys are written under: {@link MANAGED_MARKER} unless given. */
  label?: string
  /** Keys to delete outright, whoever wrote them. For secrets being rotated out. */
  remove?: readonly string[]
  /**
   * A comment line put above the first assignment of `key`, and left there when that assignment is
   * removed: the note mailer-autoconfirm.ts leaves where it takes the CLI's line out.
   */
  noteAt?: { key: string; text: string }
  /** The file in `cwd` to merge into: `.env` unless given, `.env.development.local` for instance. */
  file?: string
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
 *
 * A value with a line break or other control character in it is refused before the file is read
 * ({@link assertEnvValues}), so the file is left as it was and none of `updates` is written.
 */
export function upsertEnvFile(
  cwd: string,
  updates: Record<string, string>,
  options: UpsertOptions | readonly string[] = {},
): void {
  // Historically the third argument was a plain list of keys to remove unconditionally.
  const opts: UpsertOptions = isKeyList(options) ? { remove: options } : options
  const file = opts.file ?? ".env"
  assertEnvValues(updates, file)

  const plan = upsertPlan(updates, opts)
  const envPath = join(cwd, file)
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  const { kept, written } = mergeLines(parseLines(existing), plan)
  const body = [...kept.map((l) => l.text), ...appendedLines(plan, written)].join("\n")
  const next = `${body.replace(/\n+$/, "")}\n`
  // Not written when nothing changed. `.env` is compose's input, and a command that only read the
  // stack (push or doctor with dev running) has no business touching it.
  if (next === existing.replace(/\r\n/g, "\n")) return
  // Not created owner-only: the stack's containers read `.env` from the project mount as another
  // user, and on a Linux host a 600 file stopped the server starting.
  writeFileSync(envPath, next, "utf8")
}

/** One upsert's updates and its {@link UpsertOptions} as sets, for {@link mergeLines}. */
interface UpsertPlan {
  updates: Readonly<Record<string, string>>
  removeManaged: ReadonlySet<string>
  removeAlways: ReadonlySet<string>
  managed: ReadonlySet<string>
  label: string
  noteAt: UpsertOptions["noteAt"]
}

function upsertPlan(updates: Readonly<Record<string, string>>, opts: UpsertOptions): UpsertPlan {
  return {
    updates,
    removeManaged: new Set(opts.removeManaged ?? []),
    removeAlways: new Set(opts.remove ?? []),
    managed: new Set(opts.managed ?? []),
    label: opts.label ?? MANAGED_MARKER,
    noteAt: opts.noteAt,
  }
}

/** Puts `text` at the end of `kept`, above the marker there if there is one, so the marker stays with its line. */
function pushNote(kept: EnvLine[], text: string): void {
  const at = isMarker(kept[kept.length - 1]?.text) ? kept.length - 1 : kept.length
  kept.splice(at, 0, { text, managed: false })
}

/** The file's lines with the plan applied in place, and the keys rewritten where they were. */
function mergeLines(lines: readonly EnvLine[], plan: UpsertPlan): { kept: EnvLine[]; written: Set<string> } {
  const written = new Set<string>()
  const kept: EnvLine[] = []
  let note = plan.noteAt
  for (const line of lines) {
    const key = line.key
    if (key === undefined) {
      kept.push(line)
      continue
    }
    if (note?.key === key) {
      pushNote(kept, note.text)
      note = undefined
    }
    const removed = plan.removeAlways.has(key) || (plan.removeManaged.has(key) && line.managed)
    // A second assignment of a key rewritten above goes too: compose reads the last one, so
    // leaving it would put back the value this write replaced.
    if (removed || (key in plan.updates && written.has(key))) {
      // Drop the marker that introduced it, so no orphan comment is left behind.
      if (line.managed && isMarker(kept[kept.length - 1]?.text)) kept.pop()
      continue
    }
    if (!(key in plan.updates)) {
      kept.push(line)
      continue
    }
    const wantsMarker = plan.managed.has(key)
    relabel(kept, wantsMarker ? plan.label : undefined)
    kept.push({ key, text: `${key}=${plan.updates[key]}`, managed: wantsMarker })
    written.add(key)
  }
  return { kept, written }
}

/** The updates not rewritten in place, as lines for the end of the file, each under its marker. */
function appendedLines(plan: UpsertPlan, written: ReadonlySet<string>): string[] {
  const appended: string[] = []
  for (const [key, value] of Object.entries(plan.updates)) {
    if (written.has(key)) continue
    if (plan.managed.has(key)) appended.push(plan.label)
    appended.push(`${key}=${value}`)
  }
  return appended
}

/**
 * Put `label` above the assignment about to be written at the end of `kept`, in place of any marker
 * there; with no label, take the marker away. A marker in an older wording is brought up to date.
 */
function relabel(kept: EnvLine[], label: string | undefined): void {
  const above = kept[kept.length - 1]?.text
  if (label !== undefined && above?.trim() === label) return
  if (isMarker(above)) kept.pop()
  if (label !== undefined) kept.push({ text: label, managed: false })
}

/** Parse a project `.env`, or the env `file` named, into key/value pairs. See {@link parseEnvText}. */
export function readEnvFile(cwd: string, file = ".env"): Record<string, string> {
  const text = envText(cwd, file)
  return text === null ? {} : parseEnvText(text)
}

/**
 * `.env` then `.env.local`, the later file winning, each read through {@link parseEnvText}: what
 * native dev lays over the server's environment.
 */
export function readDotEnvFiles(cwd: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const name of [".env", ".env.local"]) {
    const envPath = join(cwd, name)
    if (existsSync(envPath)) Object.assign(vars, parseEnvText(readFileSync(envPath, "utf8")))
  }
  return vars
}

/**
 * `.env`'s text, or null when there is none, without the byte order mark Windows tools write.
 * Left in, it hid the first key from the single-key readers below.
 */
function envText(cwd: string, file = ".env"): string | null {
  const envPath = join(cwd, file)
  return existsSync(envPath) ? readFileSync(envPath, "utf8").replace(/^\uFEFF/, "") : null
}

/** `key`'s value in `.env`, or `fallback` when it is absent or blank. */
export function readEnvValue(cwd: string, key: string, fallback: string): string {
  const value = readEnvFile(cwd)[key]
  return value !== undefined && value !== "" ? value : fallback
}

/** Whether `.env` carries a non-empty value for `key`. Distinguishes absent from defaulted. */
export function hasEnvValue(cwd: string, key: string): boolean {
  return (readEnvFile(cwd)[key] ?? "") !== ""
}

/**
 * Who wrote `key` in `.env`: "cli" when it carries [`MANAGED_MARKER`], "operator" when it does not,
 * or null when `.env` has no such key.
 */
export function envValueOwner(cwd: string, key: string): "cli" | "operator" | null {
  const env = readEnvSnapshot(cwd)
  if (!(key in env.values)) return null
  return env.managed.has(key) ? "cli" : "operator"
}

/**
 * `.env` read once: its values, the keys the CLI wrote, by the marker above their last assignment,
 * and its comment lines, trimmed.
 */
export interface EnvSnapshot {
  values: Readonly<Record<string, string>>
  managed: ReadonlySet<string>
  comments: ReadonlySet<string>
}

/** `.env` as an {@link EnvSnapshot}; empty when there is no `.env`. */
export function readEnvSnapshot(cwd: string): EnvSnapshot {
  const text = envText(cwd) ?? ""
  const managed = new Set<string>()
  const comments = new Set<string>()
  // The last assignment of each key, as compose reads it.
  for (const line of parseLines(text)) {
    if (line.key === undefined) {
      if (line.text.trim().startsWith("#")) comments.add(line.text.trim())
    } else if (line.managed) managed.add(line.key)
    else managed.delete(line.key)
  }
  return { values: parseEnvText(text), managed, comments }
}

export function readEnvInt(cwd: string, key: string): number | null {
  return portNumber(readEnvValue(cwd, key, ""))
}

/**
 * A port as `docker compose --env-file .env` resolves it: the caller's environment first, then
 * `.env`. The CLI waits on the port compose binds, so it has to read it the way compose does: an
 * exported SUPATYPE_KONG_PORT used to be bound by compose while dev and push waited on the one in
 * `.env`. The one rule for a port the shell can override: a shell value that is not a port is
 * passed over for `.env`'s. `env` is the shell, given by tests.
 */
export function readComposeEnvInt(cwd: string, key: string, env: NodeJS.ProcessEnv = process.env): number | null {
  return shellEnvInt(key, env) ?? readEnvInt(cwd, key)
}

/** `key` from `env` (the shell unless given) as a port, or null when it is unset, blank or not a port. */
export function shellEnvInt(key: string, env: NodeJS.ProcessEnv = process.env): number | null {
  return portNumber(env[key]?.trim() ?? "")
}

/** `raw` as a TCP port, 1 to 65535, or null when it is not one. */
export function portNumber(raw: string): number | null {
  if (!raw) return null
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}
