/**
 * @supatype/cli: programmatic API for invoking the engine.
 *
 * For CLI usage: use the `supatype` binary.
 */

export { ensureEngine, engineRequest, engineHealth, EngineError } from "./engine-client.js"
export type { EngineResult, DiffResult, Operation, IntrospectResult } from "./engine-client.js"
export { defineConfig, env, loadConfig, loadSchemaAst } from "./config.js"
export type { AuthProviderConfig, AuthProviderName, AuthProvidersConfig, EnvReference } from "./auth-providers.js"
export type { SupatypeConfig, SupatypeProjectConfig } from "./config.js"
export { schemaPathFromProject, localDSN, connectionString, serverBaseUrl } from "./project-config.js"
