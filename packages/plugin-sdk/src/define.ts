/**
 * Builder functions for defining Supatype plugins.
 *
 * These are the primary API surface for plugin authors:
 *   defineFieldType(): custom field types (e.g., phone, currency)
 *   defineComposite(): field bundles (e.g., SEO, address)
 *   defineProvider(): service providers (e.g., Stripe, PostHog)
 *   defineWidget(): admin panel widgets (e.g., color picker)
 */

import {
  PLUGIN_API_VERSION,
  type FieldTypeDefinition,
  type CompositeDefinition,
  type ProviderDefinition,
  type WidgetDefinition,
  type PluginMeta,
} from "./types.js"

// ─── defineFieldType ─────────────────────────────────────────────────────────

/**
 * Define a custom field type plugin.
 *
 * @example
 * ```ts
 * import { defineFieldType } from '@supatype/plugin-sdk'
 *
 * export default defineFieldType({
 *   name: 'phone',
 *   pgType: 'TEXT',
 *   tsType: 'string',
 *   validate(value) {
 *     if (typeof value !== 'string') return 'Must be a string'
 *     if (!/^\+\d{7,15}$/.test(value)) return 'Invalid phone number (E.164 format required)'
 *     return null
 *   },
 *   widgetPath: './src/PhoneWidget.tsx',
 *   filterOperators: ['eq', 'neq', 'in', 'like'],
 * })
 * ```
 */
export function defineFieldType<TValue = unknown>(
  definition: FieldTypeDefinition<TValue>,
): FieldTypeDefinition<TValue> & { __supatype: "field" } {
  return {
    ...definition,
    meta: {
      name: definition.name,
      description: `Custom field type: ${definition.name}`,
      types: ["field"],
      pluginApi: PLUGIN_API_VERSION,
      ...definition.meta,
    },
    __supatype: "field" as const,
  }
}

// ─── defineComposite ─────────────────────────────────────────────────────────

/**
 * Define a composite plugin (field bundle).
 *
 * @example
 * ```ts
 * import { defineComposite } from '@supatype/plugin-sdk'
 *
 * export default defineComposite({
 *   name: 'seo',
 *   label: 'SEO Meta',
 *   fields: [
 *     { name: 'meta_title', type: 'text', options: { maxLength: 60 } },
 *     { name: 'meta_description', type: 'text', options: { maxLength: 160 } },
 *     { name: 'og_image', type: 'text' },
 *     { name: 'canonical_url', type: 'text' },
 *     { name: 'no_index', type: 'boolean', defaultValue: false },
 *   ],
 *   adminGroup: { collapsible: true, defaultCollapsed: true },
 * })
 * ```
 */
export function defineComposite(
  definition: CompositeDefinition,
): CompositeDefinition & { __supatype: "composite" } {
  const problem = unsupportedCompositeFields(definition, `Composite "${definition.name}"`)
  if (problem !== undefined) throw new Error(problem)
  return {
    ...definition,
    meta: {
      name: definition.name,
      description: `Composite: ${definition.label}`,
      types: ["composite"],
      pluginApi: PLUGIN_API_VERSION,
      ...definition.meta,
    },
    __supatype: "composite" as const,
  }
}

/**
 * Fields a composite definition may not carry. `installSQL` and `uninstallSQL` were removed before
 * plugins were public (29 Oct 2026): running them would let a package execute SQL with the
 * project owner's rights on every push. A composite is fields and their constraints, nothing else.
 */
export const UNSUPPORTED_COMPOSITE_FIELDS: readonly string[] = ["installSQL", "uninstallSQL"]

/**
 * Why `definition` cannot be a composite, or undefined when it can. `where` names it for the
 * message (a plugin package, say), since a JavaScript author or a stale build can still pass one.
 */
export function unsupportedCompositeFields(definition: object, where: string): string | undefined {
  const present = UNSUPPORTED_COMPOSITE_FIELDS.filter((field) => field in definition)
  if (present.length === 0) return undefined
  return (
    `${where} sets ${present.join(" and ")}, which ${present.length === 1 ? "is" : "are"} not supported: ` +
    "Supatype does not run SQL a plugin ships. Express what it does as fields and constraints."
  )
}

// ─── defineProvider ──────────────────────────────────────────────────────────

/**
 * Define a service provider plugin.
 *
 * @example
 * ```ts
 * import { defineProvider, type CommerceProvider } from '@supatype/plugin-sdk'
 *
 * export default defineProvider<StripeConfig>({
 *   name: 'stripe',
 *   category: 'commerce',
 *   label: 'Stripe',
 *   configSchema: {
 *     secretKey: { type: 'string', label: 'Secret Key', required: true, secret: true },
 *     webhookSecret: { type: 'string', label: 'Webhook Secret', required: true, secret: true },
 *   },
 *   create(config): CommerceProvider {
 *     return new StripeCommerceProvider(config)
 *   },
 * })
 * ```
 */
export function defineProvider<TConfig = Record<string, unknown>>(
  definition: ProviderDefinition<TConfig>,
): ProviderDefinition<TConfig> & { __supatype: "provider" } {
  return {
    ...definition,
    meta: {
      name: definition.name,
      description: `${definition.category} provider: ${definition.label}`,
      types: ["provider"],
      pluginApi: PLUGIN_API_VERSION,
      ...definition.meta,
    },
    __supatype: "provider" as const,
  }
}

// ─── defineWidget ────────────────────────────────────────────────────────────

/**
 * Define a standalone widget plugin.
 *
 * @example
 * ```ts
 * import { defineWidget } from '@supatype/plugin-sdk'
 *
 * export default defineWidget({
 *   name: 'color-picker',
 *   label: 'Colour Picker',
 *   compatibleTypes: ['text', 'varchar'],
 *   componentPath: './src/ColorPickerWidget.tsx',
 * })
 * ```
 */
export function defineWidget(
  definition: WidgetDefinition,
): WidgetDefinition & { __supatype: "widget" } {
  return {
    ...definition,
    meta: {
      name: definition.name,
      description: `Widget: ${definition.label}`,
      types: ["widget"],
      pluginApi: PLUGIN_API_VERSION,
      ...definition.meta,
    },
    __supatype: "widget" as const,
  }
}

// ─── Plugin definition union ─────────────────────────────────────────────────

export type AnyPluginDefinition =
  | (FieldTypeDefinition & { __supatype: "field" })
  | (CompositeDefinition & { __supatype: "composite" })
  | (ProviderDefinition & { __supatype: "provider" })
  | (WidgetDefinition & { __supatype: "widget" })

/**
 * Check if a value is a Supatype plugin definition.
 */
export function isPluginDefinition(value: unknown): value is AnyPluginDefinition {
  return typeof value === "object" && value !== null && "__supatype" in value
}

/**
 * Validate plugin API version compatibility.
 */
export function checkPluginApiVersion(meta: PluginMeta | undefined): {
  compatible: boolean
  message?: string | undefined
} {
  if (!meta) return { compatible: true }

  if (meta.pluginApi !== PLUGIN_API_VERSION) {
    return {
      compatible: false,
      message: `Plugin "${meta.name}" targets plugin API v${meta.pluginApi}, but the current version is v${PLUGIN_API_VERSION}. The plugin may not work correctly.`,
    }
  }

  return { compatible: true }
}
