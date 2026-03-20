/**
 * Plugin discovery and loading utilities.
 *
 * The plugin loader scans node_modules for packages with the `supatype-plugin`
 * keyword or a `supatype` field in package.json, and auto-registers them.
 */

import {
  PLUGIN_API_VERSION,
  type PluginMeta,
  type PluginType,
  type ProviderDefinition,
  type FieldTypeDefinition,
  type CompositeDefinition,
  type CompositeFieldDef,
} from "./types.js"
import {
  type AnyPluginDefinition,
  isPluginDefinition,
  checkPluginApiVersion,
} from "./define.js"

// ─── Plugin registry ─────────────────────────────────────────────────────────

export interface RegisteredPlugin {
  packageName: string
  meta: PluginMeta
  definition: AnyPluginDefinition
  status: "active" | "inactive" | "incompatible"
  incompatibleReason?: string | undefined
}

const registry = new Map<string, RegisteredPlugin>()

/**
 * Register a plugin definition.
 */
export function registerPlugin(packageName: string, definition: AnyPluginDefinition): RegisteredPlugin {
  const meta: PluginMeta = definition.meta ?? {
    name: packageName,
    description: "",
    types: [definition.__supatype],
    pluginApi: PLUGIN_API_VERSION,
  }

  const compat = checkPluginApiVersion(meta)

  const plugin: RegisteredPlugin = {
    packageName,
    meta,
    definition,
    status: compat.compatible ? "active" : "incompatible",
    ...(compat.message !== undefined ? { incompatibleReason: compat.message } : {}),
  }

  // Check for conflicts
  const existing = registry.get(definition.__supatype === "field"
    ? `field:${(definition as { name: string }).name}`
    : definition.__supatype === "provider"
    ? `provider:${(definition as { category: string }).category}:${(definition as { name: string }).name}`
    : `${definition.__supatype}:${(definition as { name: string }).name}`)

  if (existing) {
    console.warn(
      `[plugins] conflict: "${packageName}" and "${existing.packageName}" both define ` +
      `${definition.__supatype} "${(definition as { name: string }).name}". ` +
      `Resolve in supatype.config.ts plugins array.`,
    )
  }

  const key = `${definition.__supatype}:${(definition as { name: string }).name}`
  registry.set(key, plugin)
  return plugin
}

/**
 * Get all registered plugins.
 */
export function getRegisteredPlugins(): RegisteredPlugin[] {
  return Array.from(registry.values())
}

/**
 * Get plugins by type.
 */
export function getPluginsByType(type: PluginType): RegisteredPlugin[] {
  return getRegisteredPlugins().filter(p => p.definition.__supatype === type)
}

/**
 * Get a specific field type plugin by name.
 */
export function getFieldTypePlugin(name: string): RegisteredPlugin | undefined {
  return registry.get(`field:${name}`)
}

/**
 * Get a specific provider plugin by category and name.
 */
export function getProviderPlugin(category: string, name: string): RegisteredPlugin | undefined {
  return registry.get(`provider:${category}:${name}`)
}

/**
 * Clear the plugin registry (for testing).
 */
export function clearPluginRegistry(): void {
  registry.clear()
}

// ─── Package.json discovery ──────────────────────────────────────────────────

export interface PluginPackageInfo {
  name: string
  version: string
  description: string
  supatype?: {
    pluginApi?: number | undefined
    types?: PluginType[] | undefined
  } | undefined
  keywords?: string[] | undefined
}

/**
 * Check if a package.json represents a Supatype plugin.
 */
export function isSupatypePlugin(pkg: PluginPackageInfo): boolean {
  // Has a `supatype` field in package.json
  if (pkg.supatype) return true
  // Has `supatype-plugin` keyword
  if (pkg.keywords?.includes("supatype-plugin")) return true
  return false
}

// ─── Load order ──────────────────────────────────────────────────────────────

/**
 * Sort plugins by load order: providers first, then fields & composites, then widgets.
 */
export function sortByLoadOrder(plugins: RegisteredPlugin[]): RegisteredPlugin[] {
  const order: Record<string, number> = {
    provider: 0,
    field: 1,
    composite: 2,
    widget: 3,
  }

  return [...plugins].sort((a, b) => {
    const aOrder = order[a.definition.__supatype] ?? 99
    const bOrder = order[b.definition.__supatype] ?? 99
    return aOrder - bOrder
  })
}

// ─── Conflict detection ──────────────────────────────────────────────────────

export interface PluginConflict {
  type: PluginType
  name: string
  packages: string[]
  message: string
}

/**
 * Detect conflicts between a set of plugin definitions.
 */
export function detectConflicts(plugins: Array<{ packageName: string; definition: AnyPluginDefinition }>): PluginConflict[] {
  const seen = new Map<string, string[]>()
  const conflicts: PluginConflict[] = []

  for (const p of plugins) {
    const key = `${p.definition.__supatype}:${(p.definition as { name: string }).name}`
    const existing = seen.get(key) ?? []
    existing.push(p.packageName)
    seen.set(key, existing)
  }

  for (const [key, packages] of seen) {
    if (packages.length > 1) {
      const [type, name] = key.split(":", 2)
      conflicts.push({
        type: type as PluginType,
        name: name!,
        packages,
        message: `Multiple plugins define ${type} "${name}": ${packages.join(", ")}. ` +
          `Resolve by explicitly listing plugins in supatype.config.ts.`,
      })
    }
  }

  return conflicts
}

// ─── Provider validation (Task 11) ──────────────────────────────────────────

/** Optional methods on each provider category that should trigger warnings, not errors. */
const OPTIONAL_PROVIDER_METHODS: Record<string, string[]> = {
  commerce: ["createSubscription", "cancelSubscription", "getPortalUrl"],
  tracking: ["groupIdentify", "getFeatureFlag"],
  email: ["sendTemplate", "sendBatch"],
  storage: [],
  auth: [],
  ssl: [],
  ai: [],
  search: [],
  "push-notification": [],
}

export interface ProviderValidationResult {
  valid: boolean
  warnings: string[]
  errors: string[]
}

/**
 * Validate configured providers at push time.
 *
 * For each provider:
 * - Checks the definition has a `create()` method
 * - Checks required `configSchema` fields are present in the config
 * - Warns about optional interface methods not implemented
 */
export function validateProviders(
  configuredProviders: Array<{ name: string; config?: Record<string, unknown> | undefined }>,
): ProviderValidationResult {
  const warnings: string[] = []
  const errors: string[] = []

  for (const cp of configuredProviders) {
    // Find matching registered provider plugin
    const registered = getRegisteredPlugins().find(
      p => p.definition.__supatype === "provider" && (p.definition as ProviderDefinition).name === cp.name,
    )

    if (!registered) {
      errors.push(`Provider "${cp.name}" is configured but no matching plugin is registered.`)
      continue
    }

    if (registered.status === "incompatible") {
      errors.push(`Provider "${cp.name}" is incompatible: ${registered.incompatibleReason ?? "unknown reason"}.`)
      continue
    }

    const def = registered.definition as ProviderDefinition

    // Check create() method
    if (typeof def.create !== "function") {
      errors.push(`Provider "${cp.name}" definition is missing a create() method.`)
    }

    // Check required configSchema fields are present in config
    if (def.configSchema && cp.config) {
      for (const [key, schema] of Object.entries(def.configSchema)) {
        if (schema.required === true && (cp.config[key] === undefined || cp.config[key] === null)) {
          errors.push(`Provider "${cp.name}" is missing required config field "${key}".`)
        }
      }
    } else if (def.configSchema && !cp.config) {
      const requiredFields = Object.entries(def.configSchema)
        .filter(([, s]) => s.required === true)
        .map(([k]) => k)
      if (requiredFields.length > 0) {
        errors.push(
          `Provider "${cp.name}" has required config fields (${requiredFields.join(", ")}) but no config was provided.`,
        )
      }
    }

    // Warn about optional interface methods
    const optionalMethods = OPTIONAL_PROVIDER_METHODS[def.category] ?? []
    if (optionalMethods.length > 0 && typeof def.create === "function") {
      for (const method of optionalMethods) {
        // We can only check if the create function produces an instance with
        // the method at runtime, so we note the optional methods as warnings.
        warnings.push(
          `Provider "${cp.name}" (${def.category}): optional method "${method}" may not be implemented.`,
        )
      }
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  }
}

// ─── Plugin field type map (Task 15) ────────────────────────────────────────

/**
 * Returns a map of custom field type names to their declared `tsType` values
 * from registered field type plugins. Consumed by the engine's type generator.
 */
export function getPluginFieldTypeMap(): Map<string, string> {
  const map = new Map<string, string>()

  for (const plugin of getPluginsByType("field")) {
    if (plugin.status !== "active") continue
    const def = plugin.definition as FieldTypeDefinition & { __supatype: "field" }
    map.set(def.name, def.tsType)
  }

  return map
}

// ─── Plugin field Postgres type map (Task 16) ───────────────────────────────

export interface FieldPgTypeInfo {
  pgType: string
  constraints?: string[] | undefined
}

/**
 * Returns a map of custom field type names to their Postgres type and optional
 * constraints. Consumed by the engine's migration system.
 */
export function getPluginFieldPgTypeMap(): Map<string, FieldPgTypeInfo> {
  const map = new Map<string, FieldPgTypeInfo>()

  for (const plugin of getPluginsByType("field")) {
    if (plugin.status !== "active") continue
    const def = plugin.definition as FieldTypeDefinition & { __supatype: "field" }
    map.set(def.name, {
      pgType: def.pgType,
      ...(def.constraints !== undefined ? { constraints: def.constraints } : {}),
    })
  }

  return map
}

// ─── Composite expansion (Task 18) ──────────────────────────────────────────

export interface CompositeExpansion {
  fields: Array<{
    name: string
    pgType: string
    required: boolean
    defaultValue?: unknown | undefined
  }>
  installSQL?: string | undefined
  uninstallSQL?: string | undefined
}

/** Built-in type-to-pgType mapping for common types. */
const BUILTIN_PG_TYPES: Record<string, string> = {
  text: "TEXT",
  varchar: "VARCHAR",
  boolean: "BOOLEAN",
  integer: "INTEGER",
  bigint: "BIGINT",
  float: "FLOAT8",
  decimal: "NUMERIC",
  json: "JSONB",
  jsonb: "JSONB",
  date: "DATE",
  timestamp: "TIMESTAMPTZ",
  uuid: "UUID",
}

/**
 * Expand registered composite plugins into their concrete field definitions
 * with resolved Postgres types.
 *
 * For each composite field, the type is resolved by:
 * 1. Checking registered plugin field types (from getPluginFieldPgTypeMap)
 * 2. Falling back to built-in type mappings
 * 3. Defaulting to TEXT if no match is found
 */
export function expandPluginComposites(): Map<string, CompositeExpansion> {
  const result = new Map<string, CompositeExpansion>()
  const pluginFieldPgTypes = getPluginFieldPgTypeMap()

  for (const plugin of getPluginsByType("composite")) {
    if (plugin.status !== "active") continue
    const def = plugin.definition as CompositeDefinition & { __supatype: "composite" }

    const fields = def.fields.map((f: CompositeFieldDef) => {
      // Resolve pgType: plugin fields first, then built-ins, then TEXT fallback
      const pluginPg = pluginFieldPgTypes.get(f.type)
      const pgType = pluginPg?.pgType ?? BUILTIN_PG_TYPES[f.type] ?? "TEXT"

      return {
        name: f.name,
        pgType,
        required: f.required === true,
        ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
      }
    })

    result.set(def.name, {
      fields,
      ...(def.installSQL !== undefined ? { installSQL: def.installSQL } : {}),
      ...(def.uninstallSQL !== undefined ? { uninstallSQL: def.uninstallSQL } : {}),
    })
  }

  return result
}
