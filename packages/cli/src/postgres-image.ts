/**
 * The Postgres image a Docker stack runs, and whether it can serve the RESP keyspace: one decision.
 *
 * `versions.postgres` used to pin nothing: every value mapped to `supatype/postgres:<major>-latest`,
 * while the cache provider fell back to Valkey for any pin on the assumption that the pin selected
 * an image older than the keyspace toggle. The compose file and the cache disagreed about which
 * image was running, so a pin bought a Valkey sidecar beside an image that did not need one (VK2).
 *
 * Now:
 *  - an exact `X.Y.Z` (or `vX.Y.Z`) runs `supatype/postgres:X.Y.Z` when that tag exists, and
 *    otherwise `X-latest` with a warning naming the pin, the missing tag and the image run instead;
 *  - `X` or `X.Y` runs `X-latest`, never a stale `X.Y` tag;
 *  - a `-latest` pin and `database.image` run as written;
 *  - the keyspace follows the image chosen, by {@link KEYSPACE_TOGGLE_SINCE}.
 *
 * Whether an exact tag exists is IO, so it is asked once per process and the answer is kept: the
 * compose file, the `.env` image pin and the cache provider all read the same resolution.
 */
import { spawnSync } from "node:child_process"
import { pinnedVersion, VERSION_PIN_LOCAL } from "./binary-cache.js"
import { compareVersions } from "./engine-floor.js"
import type { SupatypeProjectConfig } from "./project-config.js"

const REPOSITORY = "supatype/postgres"

/**
 * The first supatype/postgres release whose entrypoint honours `SUPATYPE_KEYSPACE_ENABLED`.
 *
 * pg_keyspace itself arrived in 17.2.4, but without the toggle: an image before this one ignores
 * the variable and starts with no RESP listener. That fails nowhere; the stack comes up and the
 * cache never hits. So an exact pin below this runs beside a Valkey sidecar.
 */
export const KEYSPACE_TOGGLE_SINCE = "17.2.9"

/** Where a tag was found: on this machine, in the registry, in neither, or the check could not run. */
export type TagPresence = "local" | "published" | "missing" | "unknown"

/** Asks whether an image reference can be run. Injected so tests need no Docker or network. */
export type PostgresTagCheck = (ref: string) => TagPresence

export interface PostgresImage {
  /** The image to run, or undefined for the compose default (`supatype/postgres:latest`). */
  ref: string | undefined
  /** Whether that image serves the keyspace when asked to. False when it cannot be known. */
  keyspace: boolean
  /** Set when a pin could not be honoured exactly, naming what runs instead. */
  warning?: string
}

const EXACT = /^v?(\d+)\.(\d+)\.(\d+)$/
const FLOATING = /^(?:\d+-)?latest$/

/** Whether a supatype/postgres tag honours the keyspace toggle; false for a tag this cannot read. */
function tagHasKeyspaceToggle(tag: string): boolean {
  if (FLOATING.test(tag)) return true
  if (!EXACT.test(tag)) return false
  return compareVersions(tag, KEYSPACE_TOGGLE_SINCE) >= 0
}

/** `database.image`, run as written. A supatype/postgres tag is read like a pin; anything else is unknown. */
function configuredImage(image: string): PostgresImage {
  const prefix = `${REPOSITORY}:`
  const keyspace = image.startsWith(prefix) && tagHasKeyspaceToggle(image.slice(prefix.length))
  return { ref: image, keyspace }
}

function floatingImage(tag: string): PostgresImage {
  return { ref: `${REPOSITORY}:${tag}`, keyspace: tagHasKeyspaceToggle(tag) }
}

/** An exact pin: its own tag when it can be run, else the major's latest and a warning saying so. */
function exactImage(pin: string, version: RegExpExecArray, check: PostgresTagCheck): PostgresImage {
  const [, major, minor, patch] = version
  const tag = `${major}.${minor}.${patch}`
  const ref = `${REPOSITORY}:${tag}`
  const presence = check(ref)
  if (presence === "local" || presence === "published") return { ref, keyspace: tagHasKeyspaceToggle(tag) }
  const fallback = floatingImage(`${major}-latest`)
  const reason =
    presence === "missing"
      ? `${ref} is not published`
      : `could not check whether ${ref} is published (no Docker, or the registry could not be reached), and it is not on this machine`
  return { ...fallback, warning: `versions.postgres "${pin}": ${reason}; running ${fallback.ref} instead.` }
}

function pinnedImage(pin: string, check: PostgresTagCheck): PostgresImage {
  const exact = EXACT.exec(pin)
  if (exact) return exactImage(pin, exact, check)
  if (FLOATING.test(pin) || pin.includes("-latest")) return floatingImage(pin)
  return floatingImage(`${pin.replace(/^v/, "").split(".")[0]}-latest`)
}

/** The image this config runs under Docker, deciding with `check` whether an exact tag exists. */
export function resolvePostgresImage(config: SupatypeProjectConfig, check: PostgresTagCheck): PostgresImage {
  const image = config.database?.image?.trim()
  if (image) return configuredImage(image)
  const pin = pinnedVersion("postgres", config)
  if (pin === undefined) return { ref: undefined, keyspace: true }
  // A machine-local build is named in `.env`, not here, so nothing can be said about it.
  if (pin === VERSION_PIN_LOCAL) return { ref: undefined, keyspace: false }
  return pinnedImage(pin, check)
}

export interface DockerResult {
  status: number | null
  stderr: string
}

export type DockerRun = (args: string[]) => DockerResult

/** Long enough for a slow registry, short enough that an unreachable one does not stall a command. */
const REGISTRY_TIMEOUT_MS = 15_000

function runDocker(args: string[]): DockerResult {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: REGISTRY_TIMEOUT_MS,
  })
  return { status: result.status, stderr: result.stderr ?? "" }
}

/** Docker's answer for a tag the registry does not have, as opposed to a registry it could not ask. */
const MISSING_MANIFEST = /no such manifest|manifest unknown/i

/** Local image store first (works offline), then the registry; "unknown" when neither can answer. */
export function dockerTagCheck(run: DockerRun = runDocker): PostgresTagCheck {
  return (ref) => {
    if (run(["image", "inspect", ref]).status === 0) return "local"
    const remote = run(["manifest", "inspect", ref])
    if (remote.status === 0) return "published"
    return MISSING_MANIFEST.test(remote.stderr) ? "missing" : "unknown"
  }
}

let tagCheck: PostgresTagCheck | undefined
const resolved = new Map<string, PostgresImage>()

/** Replace the tag check (tests), or restore Docker's with undefined. Forgets earlier answers. */
export function setPostgresTagCheck(check: PostgresTagCheck | undefined): void {
  tagCheck = check
  resolved.clear()
}

/** {@link resolvePostgresImage} with Docker's check, asked once per process and warned about once. */
export function postgresImageFor(config: SupatypeProjectConfig): PostgresImage {
  const key = `${config.database?.image?.trim() ?? ""}\n${pinnedVersion("postgres", config) ?? ""}`
  const known = resolved.get(key)
  if (known) return known
  const image = resolvePostgresImage(config, tagCheck ?? dockerTagCheck())
  if (image.warning) console.warn(`[supatype] ⚠  ${image.warning}`)
  resolved.set(key, image)
  return image
}
