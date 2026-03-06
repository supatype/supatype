/**
 * @supatype/cli — programmatic API for invoking the engine.
 *
 * For CLI usage: use the `definatype` binary.
 */

export { invokeEngine, getEnginePath } from "./engine.js"
export { ENGINE_VERSION, ENGINE_REPO, ENGINE_DOWNLOAD_BASE } from "./engine-version.js"
export { defineConfig, loadConfig, loadSchemaAst } from "./config.js"
export type { DefinatypeConfig } from "./config.js"
