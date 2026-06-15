import type { AdminConfig, FieldConfig, GlobalConfig, NavGroup } from "../config.js"

function humanize(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

function pluralize(word: string): string {
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return word + "es"
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies"
  return word + "s"
}

function normalizeStudioWidget(widget: unknown): FieldConfig["widget"] {
  const raw = String(widget ?? "text")
  if (raw.toLowerCase() === "derivedtext") return "derivedText"
  return raw.toLowerCase() as FieldConfig["widget"]
}

export function mapEngineFields(rawFields: unknown): FieldConfig[] {
  return ((rawFields as unknown[]) ?? []).map((f) => {
    const fi = f as Record<string, unknown>
    return {
      name: String(fi["name"] ?? ""),
      label: String(fi["label"] ?? humanize(String(fi["name"] ?? ""))),
      widget: normalizeStudioWidget(fi["widget"]),
      required: Boolean(fi["required"] ?? false),
      localized: Boolean(fi["localized"] ?? false),
      ...(fi["showInList"] !== undefined ? { listColumn: Boolean(fi["showInList"]) } : {}),
      ...(fi["listColumn"] !== undefined ? { listColumn: Boolean(fi["listColumn"]) } : {}),
      ...(fi["sortable"] !== undefined ? { sortable: Boolean(fi["sortable"]) } : {}),
      ...(fi["filterable"] !== undefined ? { filterable: Boolean(fi["filterable"]) } : {}),
      ...(fi["options"] !== undefined ? { options: fi["options"] as Record<string, unknown> } : {}),
      ...(fi["readOnly"] !== undefined ? { readOnly: Boolean(fi["readOnly"]) } : {}),
      ...(fi["hidden"] !== undefined ? { hidden: Boolean(fi["hidden"]) } : {}),
    }
  })
}

/** Map engine admin-config.json to Studio {@link AdminConfig}. */
export function normalizeAdminConfig(raw: unknown): AdminConfig {
  const r = raw as Record<string, unknown>

  const models = ((r["models"] as unknown[]) ?? []).map((m) => {
    const mo = m as Record<string, unknown>
    const name = String(mo["name"] ?? "")
    const label = humanize(name)
    const tableName = String(mo["tableName"] ?? name)
    const fields = mapEngineFields(mo["fields"])
    return {
      name,
      label,
      labelPlural: pluralize(label),
      tableName,
      apiPath: `/rest/v1/${tableName}`,
      primaryKey: String(mo["primaryKey"] ?? "id"),
      fields,
      listColumns: (mo["listColumns"] as string[]) ?? [],
      searchFields: (mo["searchFields"] as string[]) ?? [],
      publishable: Boolean(mo["publishable"] ?? mo["publishing"] ?? false),
      versioning: Boolean(mo["versioning"] ?? false),
      softDelete: Boolean(mo["softDelete"] ?? false),
      timestamps: Boolean(mo["timestamps"] ?? false),
      hasHooks: Boolean(mo["hasHooks"] ?? false),
    }
  })

  const globals: GlobalConfig[] = ((r["globals"] as unknown[]) ?? []).map((g) => {
    const go = g as Record<string, unknown>
    const name = String(go["name"] ?? "")
    const tableName = String(go["tableName"] ?? `_global_${toGlobalSuffix(name)}`)
    return {
      name,
      label: String(go["label"] ?? humanize(name)),
      tableName,
      apiPath: `/rest/v1/${tableName}`,
      fields: mapEngineFields(go["fields"]),
    }
  })

  const rawNav = (r["navigation"] as unknown[]) ?? []
  let navigation: NavGroup[]
  if (rawNav.length > 0 && typeof (rawNav[0] as Record<string, unknown>)["group"] === "string") {
    navigation = rawNav.map((g) => {
      const gr = g as Record<string, unknown>
      return {
        label: String(gr["group"] ?? ""),
        items: ((gr["items"] as unknown[]) ?? []).map((it) => {
          const i = it as Record<string, unknown>
          const globalTable = String(i["global"] ?? "")
          if (globalTable) {
            const found = globals.find(
              (gl) => gl.tableName === globalTable || gl.name === globalTable,
            )
            return {
              label: String(i["label"] ?? found?.label ?? humanize(globalTable)),
              href: `/models/globals/${found?.name ?? globalTable}`,
              type: "global" as const,
            }
          }
          const modelName = String(i["model"] ?? "")
          const found = models.find((mo) => mo.tableName === modelName || mo.name === modelName)
          const routeName = found?.name ?? modelName
          return {
            label: String(i["label"] ?? found?.label ?? humanize(modelName)),
            href: `/models/${routeName}`,
            type: "model" as const,
          }
        }),
      }
    })
  } else if (rawNav.length > 0) {
    navigation = rawNav as NavGroup[]
  } else {
    navigation = [
      {
        label: "Content",
        items: models.map((mo) => ({
          label: mo.labelPlural,
          href: `/models/${mo.name}`,
          type: "model" as const,
        })),
      },
    ]
  }

  const rawLocale = r["localization"] as Record<string, unknown> | undefined
  const locale = rawLocale
    ? {
        locales: ((rawLocale["locales"] as string[]) ?? ["en"]).map((code) => ({
          code,
          label: code.toUpperCase(),
        })),
        defaultLocale: String(rawLocale["defaultLocale"] ?? "en"),
      }
    : undefined

  const adminRoles = Array.isArray(r["adminRoles"])
    ? (r["adminRoles"] as string[]).filter((role) => typeof role === "string" && role.length > 0)
    : undefined

  return {
    models,
    globals,
    navigation,
    ...(locale !== undefined && { locale }),
    ...(adminRoles !== undefined && adminRoles.length > 0 && { adminRoles }),
  }
}

function toGlobalSuffix(name: string): string {
  return name.replace(/([A-Z])/g, "_$1").replace(/^_/, "").toLowerCase()
}
