/**
 * @supatype/cli — programmatic API for invoking the engine.
 *
 * For CLI usage: use the `supatype` binary.
 */

export { invokeEngine, getEnginePath, ensureEngine, getEnginePathAsync } from "./engine.js"
export {
  ENGINE_VERSION,
  ENGINE_REPO,
  ENGINE_DOWNLOAD_BASE,
  CDN_BASE_URL,
  ENGINE_RELEASES_REPO,
  GITHUB_RELEASES_FALLBACK_URL,
} from "./engine-version.js"
export { defineConfig, loadConfig, loadSchemaAst } from "./config.js"
export type { SupatypeConfig } from "./config.js"
export { detectPlatform } from "./engine/platform.js"
export type { PlatformInfo } from "./engine/platform.js"
