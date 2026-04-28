import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { evalTsSnippet } from "./tsx-runner.js"
import { loadTomlConfig, type SupatypeTomlConfig } from "./config-toml.js"

// Re-export so callers can import from either module.
export type { SupatypeTomlConfig }

export interface ServiceVersionPin {
  /** Docker image tag to pin this service to (e.g. "v1.2.3"). When set, `self-host upgrade` skips this service. */
  version: string
}

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
  /**
   * Pin specific services to fixed Docker image versions.
   * When a service is pinned, `self-host upgrade` will skip it.
   * Omit a service or set to `undefined` to allow automatic upgrades.
   *
   * @example
   * services: {
   *   db: { version: "17-latest" },
   *   postgrest: { version: "v12.2.8" },
   * }
   */
  services?: {
    db?: ServiceVersionPin
    gotrue?: ServiceVersionPin
    postgrest?: ServiceVersionPin
    kong?: ServiceVersionPin
    caddy?: ServiceVersionPin
    pgbouncer?: ServiceVersionPin
  }
}

export type AppFramework = "nextjs" | "astro" | "vite" | "remix-spa" | "sveltekit" | "nuxt" | "static"

export interface AppConfig {
  /** Framework name. Auto-detected from package.json if not specified. */
  framework?: AppFramework
  /** Path to the app directory (default: "./" or "./apps/web" for monorepos). */
  directory?: string
  /** Build command (inferred from framework if not specified). */
  buildCommand?: string
  /** Output directory (inferred from framework if not specified). */
  outputDirectory?: string
  /** Enable SPA fallback routing (default: true for Vite/CRA, false for SSG frameworks). */
  spa?: boolean
  /** Environment variables to inject during build. */
  env?: Record<string, string>
  /** Custom response headers for the static site. */
  headers?: Record<string, string>
}

export interface SupatypeConfig {
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
  /** Cloud project reference (set by `supatype link --project <ref>`). */
  projectRef?: string
  /** Cloud API URL override. */
  apiUrl?: string
  /** Cloud access token (prefer SUPATYPE_ACCESS_TOKEN env var). */
  accessToken?: string
  /** CORS configuration. */
  cors?: {
    /** Allowed origins. Defaults to ['*'] in development. */
    allowedOrigins?: string[]
  }
  /** Static site hosting configuration. */
  app?: AppConfig
  /** Registered plugins (provider, field, composite, widget). */
  plugins?: Array<unknown> | undefined
  /** Admin panel configuration (see Gap Appendices tasks 47–50). */
  admin?: {
    /**
     * Roles from {ref}_auth.users that grant admin panel access.
     * Checked against `app_metadata.role` in the project JWT.
     * @default ["admin"]
     */
    roles?: string[]
  }
}

/** Identity helper — provides type inference for config files. */
export function defineConfig(config: SupatypeConfig): SupatypeConfig {
  return config
}

const TOML_CONFIG_FILE = "supatype.config.toml"

const LEGACY_CONFIG_CANDIDATES = [
  "supatype.config.ts",
  "supatype.config.js",
  "supatype.config.mjs",
]

/**
 * Load project config — TOML-first.
 *
 * Tries supatype.config.toml first. If found, delegates to loadTomlConfig.
 * If only a legacy .ts config is found, throws with a migration notice.
 * This overload is for commands that need the full project config (dev, init, etc.).
 */
export function loadConfig(cwd: string = process.cwd()): SupatypeTomlConfig {
  if (existsSync(resolve(cwd, TOML_CONFIG_FILE))) {
    return loadTomlConfig(cwd)
  }

  // Legacy config detected — print migration notice.
  for (const candidate of LEGACY_CONFIG_CANDIDATES) {
    if (existsSync(resolve(cwd, candidate))) {
      throw new Error(
        `Found ${candidate} but supatype now uses supatype.config.toml.\n` +
          "Run: supatype init --migrate  to convert your existing config.\n" +
          "See: https://docs.supatype.io/migration/toml-config",
      )
    }
  }

  throw new Error(
    "No supatype.config.toml found in the current directory.\n" +
      "Run: supatype init",
  )
}

/**
 * Load the legacy .ts config for commands that only need the schema path
 * (e.g. generate, diff) and want to support both TOML and .ts configs
 * during the transition period.
 *
 * Returns null if neither config format is found.
 * @internal
 */
export function loadLegacyTsConfig(cwd: string = process.cwd()): SupatypeConfig | null {
  for (const candidate of LEGACY_CONFIG_CANDIDATES) {
    const configPath = resolve(cwd, candidate)
    if (!existsSync(configPath)) continue

    const urlPath = "file:///" + configPath.replace(/\\/g, "/")

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

    const parsed = JSON.parse(result.stdout) as SupatypeConfig
    if (!parsed.connection || !parsed.schema) {
      throw new Error(
        `${candidate} must export { connection, schema } via defineConfig()`,
      )
    }
    return parsed
  }
  return null
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
const entries = Object.entries(named)
const models = Object.fromEntries(
  entries.filter(([, v]) => v != null && typeof v === "object" && "__modelMeta" in (v as object))
)
const globals = Object.fromEntries(
  entries.filter(([, v]) => v != null && typeof v === "object" && "__globalMeta" in (v as object))
)
const buckets = Object.fromEntries(
  entries.filter(([, v]) => v != null && typeof v === "object" && (v as { _tag?: string })._tag === "bucket")
)
const localeEntry = entries.find(([, v]) => v != null && typeof v === "object" && "__localeMeta" in (v as object))
const locale = localeEntry ? (localeEntry[1] as { __localeMeta: unknown }).__localeMeta : undefined
process.stdout.write(JSON.stringify(serialiseSchema(
  models,
  Object.keys(globals).length > 0 ? globals : undefined,
  locale as { locales: string[]; defaultLocale: string } | undefined,
  Object.keys(buckets).length > 0 ? buckets : undefined,
)))
`
  const result = evalTsSnippet(snippet, { cwd })
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to load schema from ${absPath}:\n${result.stderr || result.stdout}`,
    )
  }

  return JSON.parse(result.stdout)
}
