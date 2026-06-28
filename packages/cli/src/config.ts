import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evalTsSnippet } from "./tsx-runner.js"
import {
  mergeProjectConfig,
  validateProjectConfig,
  type SupatypeProjectConfig,
} from "./project-config.js"
import { extractSchemaAstFromTypes } from "./type-extractor.js"
import type { ExtractedSchemaAstV2 } from "./schema-ast-v2.js"

export type { SupatypeProjectConfig } from "./project-config.js"

/** Canonical project configuration shape (alias for clarity at call sites). */
export type SupatypeConfig = SupatypeProjectConfig

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

/** Identity helper — provides type inference for config files. */
export function defineConfig(config: SupatypeProjectConfig): SupatypeProjectConfig {
  return config
}

const LEGACY_TOML = "supatype.config.toml"

const MAIN_CONFIG_CANDIDATES = [
  "supatype.config.ts",
  "supatype.config.js",
  "supatype.config.mjs",
]

const LOCAL_CONFIG_CANDIDATES = [
  "supatype.local.config.ts",
  "supatype.local.config.js",
  "supatype.local.config.mjs",
]

/**
 * Normalize a config object parsed from JSON (e.g. shorthand `schema: "./x"`).
 */
function normalizeProjectJson(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw
  const o = { ...(raw as Record<string, unknown>) }
  const sch = o["schema"]
  if (typeof sch === "string") {
    o["schema"] = {
      path: sch,
      pg_schema: typeof o["pg_schema"] === "string" ? o["pg_schema"] : "public",
    }
    delete o["pg_schema"]
  }
  return o
}

/**
 * Load project config from `supatype.config.ts` (or .js/.mjs), merged with
 * optional `supatype.local.config.*` (gitignored overrides).
 */
export function loadConfig(cwd: string = process.cwd()): SupatypeProjectConfig {
  if (existsSync(resolve(cwd, LEGACY_TOML))) {
    throw new Error(
      `Found ${LEGACY_TOML}, which is no longer supported.\n` +
        "Move settings into supatype.config.ts (export default { project, database, server, app, versions, … }).\n" +
        "Run `supatype init` in a new folder for a fresh template.",
    )
  }

  const baseRaw = loadFirstTsConfig(cwd, MAIN_CONFIG_CANDIDATES)
  if (baseRaw === null) {
    throw new Error(
      "No supatype.config.ts (or .js/.mjs) found in the current directory.\n" +
        "Run: supatype init",
    )
  }

  const baseNorm = normalizeProjectJson(baseRaw)
  const base = validateProjectConfig(baseNorm, "supatype.config.ts")

  const localRaw = loadFirstTsConfig(cwd, LOCAL_CONFIG_CANDIDATES)
  if (localRaw === null) return base

  const localNorm = normalizeProjectJson(localRaw) as Partial<SupatypeProjectConfig>
  return mergeProjectConfig(base, localNorm)
}

function loadFirstTsConfig(
  cwd: string,
  candidates: string[],
): Record<string, unknown> | null {
  for (const candidate of candidates) {
    const configPath = resolve(cwd, candidate)
    if (!existsSync(configPath)) continue

    const urlPath = "file:///" + configPath.replace(/\\/g, "/")
    const snippet = `
const mod = await import(${JSON.stringify(urlPath)})
const config = mod.default ?? mod
process.stdout.write(JSON.stringify(config))
`
    const result = evalTsSnippet(snippet, { cwd })
    if (result.exitCode === 0) {
      return JSON.parse(result.stdout) as Record<string, unknown>
    }

    const failure = result.stderr || result.stdout
    if (!shouldStripCliImportOnLoadFailure(failure)) {
      throw new Error(`Failed to load ${candidate}:\n${failure}`)
    }

    const fallback = loadTsConfigWithoutCliImport(configPath, cwd)
    if (fallback !== null) return fallback
    throw new Error(`Failed to load ${candidate}:\n${failure}`)
  }
  return null
}

/** When @supatype/cli is not installed yet (e.g. during `supatype init`), strip its import. */
function shouldStripCliImportOnLoadFailure(failure: string): boolean {
  if (failure.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")) return true
  if (!failure.includes("@supatype/cli")) return false
  return (
    failure.includes("ERR_MODULE_NOT_FOUND") ||
    failure.includes("MODULE_NOT_FOUND") ||
    failure.includes("Cannot find module '@supatype/cli'") ||
    failure.includes('Cannot find package \'@supatype/cli\'')
  )
}

function loadTsConfigWithoutCliImport(
  configPath: string,
  cwd: string,
): Record<string, unknown> | null {
  const original = readFileSync(configPath, "utf8")
  const patched = original
    .replace(/^import\s+type\s+\{[^}]*\}\s+from\s+["']@supatype\/cli["'];?\s*$/gm, "")
    .replace(/^import\s+\{[^}]*defineConfig[^}]*\}\s+from\s+["']@supatype\/cli["'];?\s*$/gm, "")

  // If the file didn't import from @supatype/cli, this fallback won't help.
  if (patched === original) return null

  const tmpPath = join(tmpdir(), `supatype-config-fallback-${Date.now()}.mts`)
  const wrapper = `const defineConfig = (config) => config\n${patched}`
  writeFileSync(tmpPath, wrapper, "utf8")
  try {
    const urlPath = "file:///" + tmpPath.replace(/\\/g, "/")
    const snippet = `
const mod = await import(${JSON.stringify(urlPath)})
const config = mod.default ?? mod
process.stdout.write(JSON.stringify(config))
`
    const result = evalTsSnippet(snippet, { cwd })
    if (result.exitCode !== 0) return null
    return JSON.parse(result.stdout) as Record<string, unknown>
  } finally {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore cleanup errors
    }
  }
}

/** Load schema AST by evaluating the user's schema entry point via tsx. */
export function loadSchemaAst(
  schemaPath: string,
  cwd: string = process.cwd(),
): ExtractedSchemaAstV2 {
  const extracted = extractSchemaAstFromTypes(schemaPath, cwd)
  if (extracted !== null) return extracted

  const absPath = resolve(cwd, schemaPath)
  if (!existsSync(absPath)) {
    throw new Error(`Schema file not found: ${absPath}`)
  }

  throw new Error(
    "Runtime model() schemas are no longer supported.\n" +
      `Could not extract type-based models from: ${absPath}\n` +
      "Migrate this file to @supatype/types Model<> definitions (or run `supatype migrate-from-v1`).",
  )
}
