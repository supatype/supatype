/**
 * @supatype/cli — programmatic API for invoking the engine.
 *
 * For CLI usage: use the `supatype` binary.
 */

export { ensureEngine, engineRequest, engineHealth, EngineError } from "./engine-client.js"
export type { EngineResult, DiffResult, Operation, IntrospectResult } from "./engine-client.js"
export { defineConfig, loadConfig, loadSchemaAst, loadLegacyTsConfig } from "./config.js"
export type { SupatypeConfig, SupatypeTomlConfig } from "./config.js"
export { loadTomlConfig, schemaPathFromToml, localDSN } from "./config-toml.js"
