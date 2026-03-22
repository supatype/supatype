/**
 * The engine binary version this CLI package expects.
 * Update this whenever a new engine binary is released.
 *
 * The CLI always downloads and uses this exact version.
 * Upgrading the CLI (npm update) may bump the pinned engine version.
 * This ensures CLI and engine are always compatible.
 *
 * Versioning policy:
 *   0.x.y-alpha.N  — alpha
 *   0.x.y-beta.N   — beta
 *   0.x.y          — stable pre-1.0
 *   1.0.0          — cloud launch
 *   Major bumps (1.0 → 2.0) indicate breaking changes to the schema AST format.
 */
export const ENGINE_VERSION = "0.1.0"

/**
 * Primary CDN for engine binary distribution.
 * Hetzner Object Storage behind Cloudflare edge caching.
 */
export const CDN_BASE_URL = "https://releases.supatype.dev/engine"

/**
 * Fallback: GitHub Releases on the public engine-releases repo.
 * Used when the primary CDN is unavailable.
 * Contains only binaries — no source code.
 */
export const ENGINE_RELEASES_REPO = "supatype/engine-releases"
export const GITHUB_RELEASES_FALLBACK_URL =
  `https://github.com/${ENGINE_RELEASES_REPO}/releases/download`

/**
 * Legacy: GitHub repository for direct engine releases (before CDN).
 * Kept for backwards compatibility with existing downloads.
 */
export const ENGINE_REPO = "supatype/schema-engine"
export const ENGINE_DOWNLOAD_BASE =
  `https://github.com/${ENGINE_REPO}/releases/download/v${ENGINE_VERSION}`
