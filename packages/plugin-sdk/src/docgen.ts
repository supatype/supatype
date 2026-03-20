/**
 * Plugin documentation generator.
 *
 * Generates Markdown documentation from a plugin's type definitions.
 */

import type {
  FieldTypeDefinition,
  CompositeDefinition,
  ProviderDefinition,
  WidgetDefinition,
} from "./types.js"
import type { AnyPluginDefinition } from "./define.js"

function escapeMarkdown(text: string): string {
  return text.replace(/[|\\`*_{}[\]()#+\-.!]/g, "\\$&")
}

function generateFieldDocs(def: FieldTypeDefinition & { __supatype: "field" }): string {
  const lines: string[] = []

  lines.push("## Field Type")
  lines.push("")
  lines.push(`| Property | Value |`)
  lines.push(`| --- | --- |`)
  lines.push(`| Name | \`${def.name}\` |`)
  lines.push(`| Postgres Type | \`${def.pgType}\` |`)
  lines.push(`| TypeScript Type | \`${def.tsType}\` |`)

  if (def.validate !== undefined) {
    lines.push(`| Validate | \`${def.validate.toString().slice(0, 80)}\` |`)
  }

  if (def.filterOperators !== undefined) {
    lines.push(`| Filter Operators | ${def.filterOperators.map(o => `\`${o}\``).join(", ")} |`)
  }

  if (def.widgetPath !== undefined) {
    lines.push(`| Widget Path | \`${def.widgetPath}\` |`)
  }

  lines.push("")

  if (def.constraints !== undefined && def.constraints.length > 0) {
    lines.push("### Constraints")
    lines.push("")
    for (const c of def.constraints) {
      lines.push(`- \`${c}\``)
    }
    lines.push("")
  }

  return lines.join("\n")
}

function generateCompositeDocs(def: CompositeDefinition & { __supatype: "composite" }): string {
  const lines: string[] = []

  lines.push("## Composite")
  lines.push("")
  lines.push(`**Label:** ${escapeMarkdown(def.label)}`)
  lines.push("")
  lines.push("### Fields")
  lines.push("")
  lines.push(`| Name | Type | Required | Default |`)
  lines.push(`| --- | --- | --- | --- |`)

  for (const field of def.fields) {
    const req = field.required === true ? "Yes" : "No"
    const defaultVal = field.defaultValue !== undefined ? `\`${String(field.defaultValue)}\`` : "-"
    lines.push(`| ${field.name} | \`${field.type}\` | ${req} | ${defaultVal} |`)
  }

  lines.push("")

  if (def.adminGroup !== undefined) {
    lines.push("### Admin Group")
    lines.push("")
    if (def.adminGroup.collapsible !== undefined) {
      lines.push(`- Collapsible: ${def.adminGroup.collapsible}`)
    }
    if (def.adminGroup.defaultCollapsed !== undefined) {
      lines.push(`- Default Collapsed: ${def.adminGroup.defaultCollapsed}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

function generateProviderDocs(def: ProviderDefinition & { __supatype: "provider" }): string {
  const lines: string[] = []

  lines.push("## Provider")
  lines.push("")
  lines.push(`**Category:** ${def.category}`)
  lines.push("")

  if (def.configSchema && Object.keys(def.configSchema).length > 0) {
    lines.push("### Config Schema")
    lines.push("")
    lines.push(`| Field | Type | Label | Required | Secret |`)
    lines.push(`| --- | --- | --- | --- | --- |`)

    for (const [key, schema] of Object.entries(def.configSchema)) {
      const req = schema.required === true ? "Yes" : "No"
      const secret = schema.secret === true ? "Yes" : "No"
      lines.push(`| ${key} | \`${schema.type}\` | ${escapeMarkdown(schema.label)} | ${req} | ${secret} |`)
    }

    lines.push("")
  }

  return lines.join("\n")
}

function generateWidgetDocs(def: WidgetDefinition & { __supatype: "widget" }): string {
  const lines: string[] = []

  lines.push("## Widget")
  lines.push("")
  lines.push(`| Property | Value |`)
  lines.push(`| --- | --- |`)
  lines.push(`| Name | \`${def.name}\` |`)
  lines.push(`| Label | ${escapeMarkdown(def.label)} |`)
  lines.push(`| Compatible Types | ${def.compatibleTypes.map(t => `\`${t}\``).join(", ")} |`)
  lines.push(`| Component Path | \`${def.componentPath}\` |`)
  lines.push("")

  return lines.join("\n")
}

/**
 * Generate Markdown documentation from a plugin definition.
 *
 * The output includes YAML frontmatter with the plugin name, type, and version,
 * followed by type-specific documentation sections.
 */
export function generatePluginDocs(definition: AnyPluginDefinition): string {
  const name = (definition as { name: string }).name
  const type = definition.__supatype
  const version = definition.meta?.pluginApi ?? 1

  const frontmatter = [
    "---",
    `name: "${name}"`,
    `type: "${type}"`,
    `version: ${version}`,
    "---",
  ].join("\n")

  const header = `# ${name}\n`

  let body: string

  switch (definition.__supatype) {
    case "field":
      body = generateFieldDocs(definition)
      break
    case "composite":
      body = generateCompositeDocs(definition)
      break
    case "provider":
      body = generateProviderDocs(definition)
      break
    case "widget":
      body = generateWidgetDocs(definition)
      break
  }

  return `${frontmatter}\n\n${header}\n${body}`
}
