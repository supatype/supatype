import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { evalTsSnippet } from "./tsx-runner.js"

export interface SelfHostConfig {
  /** Production domain (e.g. "api.example.com"). Used by Caddy for HTTPS. */
  domain: string
  /** App service to include in the production stack. */
  app?: {
    /** Path to the app's Dockerfile, relative to the project root. */
    dockerfile: string
    /** Port the app listens on. */
    port: number
  }
  ssl?: {
    /** SSL provider. "caddy" = automatic Let's Encrypt. "none" = bring your own. */
    provider: "caddy" | "none"
    /** Email for Let's Encrypt registration (required when provider = "caddy"). */
    email?: string
  }
}

export interface DefinatypeConfig {
  /** Database connection string. */
  connection: string
  /**
   * Path (or glob) to the schema entry point.
   * Must export model definitions as named exports.
   * @example "./schema/index.ts"
   */
  schema: string
  output?: {
    /** Path for generated TypeScript types. */
    types?: string
    /** Path for generated client helpers. */
    client?: string
  }
  /** Self-hosted production deployment configuration. */
  selfHost?: SelfHostConfig
}

/** Identity helper — provides type inference for config files. */
export function defineConfig(config: DefinatypeConfig): DefinatypeConfig {
  return config
}

const CONFIG_CANDIDATES = [
  "supatype.config.ts",
  "supatype.config.js",
  "supatype.config.mjs",
]

/** Load and evaluate supatype.config.ts from the given directory. */
export function loadConfig(cwd: string = process.cwd()): DefinatypeConfig {
  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = resolve(cwd, candidate)
    if (!existsSync(configPath)) continue

    const urlPath = "file:///" + configPath.replace(/\\/g, "/")

    // Use dynamic import so we can always access .default —
    // files without a parent package.json are treated as CJS by tsx,
    // meaning export default becomes module.exports.default rather than
    // the namespace default. Dynamic import + fallback handles both.
    const snippet = `
const mod = await import(${JSON.stringify(urlPath)})
const config = mod.default ?? mod
process.stdout.write(JSON.stringify(config))
`
    const result = evalTsSnippet(snippet, { cwd })
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to load ${candidate}:\n${result.stderr || result.stdout}`,
      )
    }

    const parsed = JSON.parse(result.stdout) as DefinatypeConfig
    if (!parsed.connection || !parsed.schema) {
      throw new Error(
        `${candidate} must export { connection, schema } via defineConfig()`,
      )
    }
    return parsed
  }

  throw new Error(
    "No supatype.config.ts found in the current directory.\n" +
      "Run: supatype init",
  )
}

/** Load schema AST by evaluating the user's schema entry point via tsx. */
export function loadSchemaAst(
  schemaPath: string,
  cwd: string = process.cwd(),
): unknown {
  const absPath = resolve(cwd, schemaPath)
  if (!existsSync(absPath)) {
    throw new Error(`Schema file not found: ${absPath}`)
  }

  const urlPath = "file:///" + absPath.replace(/\\/g, "/")

  const snippet = `
import { serialiseSchema } from "@supatype/schema"
const mod = await import(${JSON.stringify(urlPath)})
const { default: _default, ...named } = mod
const models = Object.fromEntries(
  Object.entries(named).filter(([, v]) =>
    v != null && typeof v === "object" && "__modelMeta" in (v as object)
  )
)
process.stdout.write(JSON.stringify(serialiseSchema(models)))
`
  const result = evalTsSnippet(snippet, { cwd })
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to load schema from ${absPath}:\n${result.stderr || result.stdout}`,
    )
  }

  return JSON.parse(result.stdout)
}
