import type { AccessDef, AnyField, IndexDef } from "./types.js"

// ─── Global (singleton) definition ──────────────────────────────────────────────

export interface GlobalMeta {
  name: string
  tableName: string
  fields: Record<string, AnyField>
  access: AccessDef
}

export interface GlobalDefinition<TFields extends Record<string, AnyField>> {
  /** @internal */
  readonly __globalMeta: GlobalMeta
  readonly fields: TFields
}

interface GlobalDefinitionInput<TFields extends Record<string, AnyField>> {
  fields: TFields
  access?: AccessDef
  tableName?: string
}

/**
 * Define a global config (singleton). Unlike models, globals have exactly one
 * row — they represent site-wide settings like navigation, footer content,
 * SEO defaults, etc.
 *
 * @example
 * ```ts
 * const SiteSettings = global("siteSettings", {
 *   fields: {
 *     siteName: field.text({ required: true }),
 *     logo: field.image({ bucket: "branding" }),
 *     footerHtml: field.richText(),
 *     defaultLocale: field.text({ required: true }),
 *   },
 *   access: {
 *     read: access.public(),
 *     update: access.role("admin"),
 *   },
 * })
 * ```
 */
export function global<TFields extends Record<string, AnyField>>(
  name: string,
  definition: GlobalDefinitionInput<TFields>,
): GlobalDefinition<TFields> {
  const tableName = definition.tableName ?? `_global_${toSnakeCase(name)}`

  const meta: GlobalMeta = {
    name,
    tableName,
    fields: definition.fields,
    access: definition.access ?? {},
  }

  return {
    __globalMeta: meta,
    fields: definition.fields,
  }
}

function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z])/g, (_, c: string, i: number) => (i > 0 ? "_" : "") + c.toLowerCase())
    .replace(/\s+/g, "_")
    .toLowerCase()
}
