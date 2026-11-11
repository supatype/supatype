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
import { askDockerSync, DOCKER_QUERY_TIMEOUT_MS, dockerHasImage } from "./docker-exec.js"
import { pinnedVersion, VERSION_PIN_LOCAL } from "./binary-cache.js"
import { compareVersions } from "./engine-floor.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { pinnedComponentVersion, RELEASE_IMAGES } from "./release-images.js"

const REPOSITORY = "supatype/postgres"

/**
 * The first supatype/postgres release whose entrypoint honours `SUPATYPE_KEYSPACE_ENABLED`.
 *
 * pg_keyspace itself arrived in 17.2.4, but without the toggle: an image before this one ignores
 * the variable and starts with no RESP listener. That fails nowhere; the stack comes up and the
 * cache never hits. So an exact pin below this runs beside a Valkey sidecar.
 */
export const KEYSPACE_TOGGLE_SINCE = "17.2.9"

/**
 * The first supatype/postgres release whose keyspace can require a password: the image takes
 * `SUPATYPE_KEYSPACE_PASSWORD`, and the extension has `pg_keyspace.password_file` and
 * `pg_keyspace.listen_address`. Before it, a keyspace with a credential still let a client with
 * no password list every key and FLUSHALL (0.9.2 release test, N-RB2), so native dev serves no
 * keyspace from an older archive, and an older image is given no password it would ignore.
 */
export const KEYSPACE_AUTH_SINCE = "17.2.13"

/** Where a tag was found: on this machine, in the registry, in neither, or the check could not run. */
export type TagPresence = "local" | "published" | "missing" | "unknown"

/** Asks whether an image reference can be run. Injected so tests need no Docker or network. */
export type PostgresTagCheck = (ref: string) => TagPresence

export interface PostgresImage {
  /**
   * The image to run, or undefined for the compose default: the Postgres release this CLI pins
   * (`RELEASE_IMAGES.postgres`). Left undefined rather than written out so `.env` holds no pin the
   * project never asked for, and a CLI upgrade moves the default with it.
   */
  ref: string | undefined
  /** Whether that image serves the keyspace when asked to. False when it cannot be known. */
  keyspace: boolean
  /** Whether that image requires the keyspace password it is given ({@link KEYSPACE_AUTH_SINCE}). */
  keyspaceAuth: boolean
  /** Set when a pin could not be honoured exactly, naming what runs instead. */
  warning?: string
}

const EXACT = /^v?(\d+)\.(\d+)\.(\d+)$/
const FLOATING = /^(?:\d+-)?latest$/

/** Whether a supatype/postgres tag is `since` or later; a floating tag is, and one this cannot read is not. */
function tagIsSince(tag: string, since: string): boolean {
  if (FLOATING.test(tag)) return true
  return postgresVersionIsSince(tag, since)
}

/** Whether an exact Postgres release version is `since` or later; false for anything else, or none. */
function postgresVersionIsSince(version: string | null, since: string): boolean {
  return version !== null && EXACT.test(version) && compareVersions(version.replace(/^v/, ""), since) >= 0
}

/**
 * Whether a native Postgres archive of `version` can require a keyspace password. Exact versions
 * only: a native archive is downloaded by exact version, and one whose version is unknown (a local
 * `overrides.postgres_dir` build) gets the Valkey sidecar rather than an unsecured keyspace.
 */
export function archiveHasKeyspaceAuth(version: string | null): boolean {
  return postgresVersionIsSince(version, KEYSPACE_AUTH_SINCE)
}

/** What a supatype/postgres tag can do with the keyspace. */
function tagKeyspace(tag: string): Pick<PostgresImage, "keyspace" | "keyspaceAuth"> {
  return { keyspace: tagIsSince(tag, KEYSPACE_TOGGLE_SINCE), keyspaceAuth: tagIsSince(tag, KEYSPACE_AUTH_SINCE) }
}

/** An image nothing can be said about: no keyspace, so no password either. */
const UNKNOWN_KEYSPACE = { keyspace: false, keyspaceAuth: false } as const

/** `database.image`, run as written. A supatype/postgres tag is read like a pin; anything else is unknown. */
function configuredImage(image: string): PostgresImage {
  const prefix = `${REPOSITORY}:`
  return { ref: image, ...(image.startsWith(prefix) ? tagKeyspace(image.slice(prefix.length)) : UNKNOWN_KEYSPACE) }
}

function floatingImage(tag: string): PostgresImage {
  return { ref: `${REPOSITORY}:${tag}`, ...tagKeyspace(tag) }
}

/** An exact pin: its own tag when it can be run, else the major's latest and a warning saying so. */
function exactImage(pin: string, version: RegExpExecArray, check: PostgresTagCheck): PostgresImage {
  const [, major, minor, patch] = version
  const tag = `${major}.${minor}.${patch}`
  const ref = `${REPOSITORY}:${tag}`
  const presence = check(ref)
  if (presence === "local" || presence === "published") return { ref, ...tagKeyspace(tag) }
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
  if (pin === undefined) return { ref: undefined, ...tagKeyspace(pinnedComponentVersion("postgres")) }
  // A machine-local build is named in `.env`, not here, so nothing can be said about it.
  if (pin === VERSION_PIN_LOCAL) return { ref: undefined, ...UNKNOWN_KEYSPACE }
  return pinnedImage(pin, check)
}

export interface DockerResult {
  status: number | null
  stderr: string
}

/** The two questions a tag check asks Docker; a test answers them itself. */
export interface TagQuestions {
  /** Whether this machine has the image. */
  hasImage: (ref: string) => boolean
  /** `docker manifest inspect`: whether the registry has it, and what it said when not. */
  manifest: (ref: string) => DockerResult
}

/**
 * Asked synchronously: the image is resolved while compose is rendered, which is synchronous. Long
 * enough for a slow registry, short enough that an unreachable one does not stall a command.
 */
const LIVE_TAG_QUESTIONS: TagQuestions = {
  hasImage: dockerHasImage,
  manifest: (ref) => askDockerSync(["manifest", "inspect", ref], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS }),
}

/** Docker's answer for a tag the registry does not have, as opposed to a registry it could not ask. */
const MISSING_MANIFEST = /no such manifest|manifest unknown/i

/** Local image store first (works offline), then the registry; "unknown" when neither can answer. */
export function dockerTagCheck(ask: TagQuestions = LIVE_TAG_QUESTIONS): PostgresTagCheck {
  return (ref) => {
    if (ask.hasImage(ref)) return "local"
    const remote = ask.manifest(ref)
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

/** The Postgres image a Docker stack runs: the one {@link postgresImageFor} names, or this release's. */
export function runningPostgresImage(config: SupatypeProjectConfig): string {
  return postgresImageFor(config).ref ?? RELEASE_IMAGES.postgres
}
