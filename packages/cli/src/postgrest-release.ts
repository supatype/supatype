/**
 * The one PostgREST release every stack runs: the self-host and dev compose image, and the binary
 * native `supatype dev` downloads.
 *
 * The two used to be separate literals and had drifted apart (the image said 12.2.8, the native
 * download 12.2.3). At least 14.4, because earlier releases fail a PATCH or DELETE filtered with
 * `or`/`and` whose `select` leaves out the filtered column (PostgREST#3707), and the fix was never
 * backported to 12 or 13.
 */

import type { PlatformId } from "./binary-cache.js"

/** PostgREST version, as its release tags spell it after the `v`. */
export const POSTGREST_VERSION = "14.18"

/** The Docker image compose runs. */
export const POSTGREST_IMAGE = `postgrest/postgrest:v${POSTGREST_VERSION}`

const POSTGREST_RELEASES = "https://github.com/PostgREST/postgrest/releases/download"

/**
 * The release archive built for `platform`.
 *
 * Spelled the way the 14.x releases name their assets: `x86-64` and `aarch64`, a static Linux
 * build for x86-64 only and an Ubuntu one for aarch64, and no Windows build for arm64, where the
 * x86-64 one runs under emulation.
 */
export function postgrestArchiveName(platform: PlatformId, version: string = POSTGREST_VERSION): string {
  const arch = platform.arch === "arm64" ? "aarch64" : "x86-64"
  const prefix = `postgrest-v${version}`
  if (platform.os === "windows") return `${prefix}-windows-x86-64.zip`
  if (platform.os === "darwin") return `${prefix}-macos-${arch}.tar.xz`
  return platform.arch === "arm64" ? `${prefix}-ubuntu-aarch64.tar.xz` : `${prefix}-linux-static-x86-64.tar.xz`
}

/** Where the archive for `platform` is downloaded from. */
export function postgrestArchiveUrl(platform: PlatformId, version: string = POSTGREST_VERSION): string {
  return `${POSTGREST_RELEASES}/v${version}/${postgrestArchiveName(platform, version)}`
}
