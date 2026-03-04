/**
 * The engine binary version this CLI package expects.
 * Update this whenever a new engine binary is released.
 */
export const ENGINE_VERSION = "0.1.0"

/**
 * GitHub repository where engine binaries are released.
 * Change to your org/repo once the engine repo is set up.
 */
export const ENGINE_REPO = "definatype/definatype-schema-engine"

/**
 * Base URL for downloading engine binaries.
 * Binaries are published as GitHub Release assets.
 */
export const ENGINE_DOWNLOAD_BASE =
  `https://github.com/${ENGINE_REPO}/releases/download/v${ENGINE_VERSION}`
