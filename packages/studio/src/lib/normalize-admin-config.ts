import type {
  AdminConfig,
  FieldConfig,
  GlobalConfig,
  ModelConfig,
  ModelVersionsConfig,
  NavGroup,
} from "../config.js"

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
      ...(fi["searchable"] !== undefined ? { searchable: Boolean(fi["searchable"]) } : {}),
      // The field's declared bounds, carried through rather than rebuilt. Studio checks these
      // before it sends a write, so a dropped `validation` is a form that accepts a value the
      // database is about to refuse, and a Rules tab that reports a bounded field as unbounded.
      ...(fi["validation"] !== undefined
        ? { validation: fi["validation"] as NonNullable<FieldConfig["validation"]> }
        : {}),
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
      // A model may say which columns to search, or the columns may say it themselves with
      // `Searchable<T>`. The explicit list wins where it exists — its order is meaningful, the
      // list view filters on the first — and the field flags are the fallback, so a schema that
      // only marks fields still gets a search box rather than silently getting none.
      searchFields: (mo["searchFields"] as string[])
        ?? fields.filter((f) => f.searchable === true).map((f) => f.name),
      publishable: Boolean(mo["publishable"] ?? mo["publishing"] ?? false),
      versions: normalizeVersions(mo["versions"]),
      softDelete: Boolean(mo["softDelete"] ?? false),
      timestamps: Boolean(mo["timestamps"] ?? false),
      hasHooks: Boolean(mo["hasHooks"] ?? false),
      // Model-level rules, carried through for the same reason as a field's bounds: they are what
      // the database enforces, and nothing else in Studio can derive them. Without these the Rules
      // tab reports a model with fourteen live check constraints as having none.
      ...(mo["constraints"] !== undefined
        ? { constraints: mo["constraints"] as NonNullable<ModelConfig["constraints"]> }
        : {}),
      ...(mo["indexes"] !== undefined
        ? { indexes: mo["indexes"] as NonNullable<ModelConfig["indexes"]> }
        : {}),
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

  // Where each model renders, when the project has said.
  //
  // Carried through explicitly, because this function is the boundary: the CLI writes a key into
  // `admin-config.json` and Studio only ever sees what is rebuilt here. A key added to the file and
  // not added here is not a broken feature with an error, it is a feature that silently does
  // nothing, which is how the live preview pane and every preview link were dead on self-host while
  // the config file on disk looked exactly right.
  //
  // Entries are filtered rather than trusted: a model naming neither an address nor a pattern
  // configures nothing, and keeping it would make Studio offer a share link that resolves nowhere.
  const rawPreview = r["livePreview"] as Record<string, unknown> | undefined
  const livePreview =
    rawPreview !== null && typeof rawPreview === "object"
      ? Object.fromEntries(
          Object.entries(rawPreview)
            .map(([model, entry]) => [model, entry as Record<string, unknown>] as const)
            .filter(([, entry]) => entry !== null && typeof entry === "object")
            .map(([model, entry]) => {
              // Empty counts as absent, the same way the resolver treats it. A model whose only
              // address is "" names nowhere, and keeping it would put a share control on screen
              // that mints a credential no link can carry.
              const text = (value: unknown): string | undefined =>
                typeof value === "string" && value !== "" ? value : undefined
              const url = text(entry["url"])
              const urlPattern = text(entry["urlPattern"])
              return [model, { ...(url !== undefined && { url }), ...(urlPattern !== undefined && { urlPattern }) }] as const
            })
            .filter(([, entry]) => entry.url !== undefined || entry.urlPattern !== undefined),
        )
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
    ...(livePreview !== undefined && Object.keys(livePreview).length > 0 && { livePreview }),
  }
}

function toGlobalSuffix(name: string): string {
  return name.replace(/([A-Z])/g, "_$1").replace(/^_/, "").toLowerCase()
}

/**
 * The model's `versions` object, or `null` when it declares none.
 *
 * Defensive about the shape rather than trusting it: this config is fetched at runtime and an older
 * engine sends no `versions` key at all, in which case the version UI should be absent rather than
 * half-rendered against undefined.
 */
function normalizeVersions(raw: unknown): ModelVersionsConfig | null {
  if (typeof raw !== "object" || raw === null) return null
  const value = raw as Record<string, unknown>
  const versionsTable = value["versionsTable"]
  if (typeof versionsTable !== "string" || versionsTable.length === 0) return null
  return {
    drafts: value["drafts"] !== false,
    keep: typeof value["keep"] === "number" && value["keep"] >= 1 ? value["keep"] : 20,
    versionsTable,
    localizedColumns: Array.isArray(value["localizedColumns"])
      ? value["localizedColumns"].filter((c): c is string => typeof c === "string")
      : [],
  }
}
