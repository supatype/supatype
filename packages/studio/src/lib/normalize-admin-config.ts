import {
  WIDGET_TYPES,
  type AdminConfig,
  type FieldConfig,
  type FieldValidation,
  type GlobalConfig,
  type LivePreviewConfig,
  type LocaleConfigAdmin,
  type ModelConfig,
  type ModelIndex,
  type ModelVersionsConfig,
  type NavGroup,
  type NavItem,
} from "../config.js"
import { isModelConstraint } from "./evaluate-constraint.js"
import { pluralize, singularize } from "./inflect.js"
import {
  isArrayOf,
  isBoolean,
  isJsonObject,
  isNumber,
  isOneOf,
  isShape,
  isString,
  optional,
  type Guard,
} from "./json.js"

function humanize(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

/** `value` when it is a non-empty string. Empty counts as absent: it names nothing. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** The objects in `value` when it is an array, skipping any entry that is not one. */
function objectsIn(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : []
}

const isStringArray = isArrayOf(isString)

function isNumberOrString(value: unknown): value is number | string {
  return isNumber(value) || isString(value)
}

/** The bounds the engine writes for a field (`field_validation` in the engine's admin generator). */
const isFieldValidation: Guard<FieldValidation> = isShape({
  maxLength: optional(isNumber),
  minLength: optional(isNumber),
  maxItems: optional(isNumber),
  minItems: optional(isNumber),
  min: optional(isNumberOrString),
  max: optional(isNumberOrString),
})

const isModelIndex: Guard<ModelIndex> = isShape({
  name: isString,
  fields: isStringArray,
  unique: isBoolean,
  using: isString,
})

const isNavItem: Guard<NavItem> = isShape({
  label: isString,
  icon: optional(isString),
  href: isString,
  type: isOneOf(["model", "global", "media", "dashboard", "custom"] as const),
})

/** A navigation group already in Studio's own shape, as a static config override writes it. */
const isNavGroup: Guard<NavGroup> = isShape({
  label: isString,
  icon: optional(isString),
  items: isArrayOf(isNavItem),
})

const isWidgetType = isOneOf(WIDGET_TYPES)

/**
 * What Studio calls one record of a model, and many.
 *
 * The project's own words win where its model meta set them. Otherwise both come from the type
 * name, and a type named in the plural (`Places`, `Children`) is still one record per row, so the
 * singular reads "Create Place" and the plural does not become "Placeses". A plural is inflected
 * from the singular override when only that was set, so `label` alone is enough for most names.
 */
function modelLabels(mo: Record<string, unknown>, name: string): { label: string; labelPlural: string } {
  const label = nonEmptyString(mo["label"]) ?? singularize(humanize(name))
  return { label, labelPlural: nonEmptyString(mo["labelPlural"]) ?? pluralize(label) }
}

/** The widget the engine named, matched without regard to case. A name Studio has no widget for renders as text. */
function normalizeStudioWidget(widget: unknown): FieldConfig["widget"] {
  const raw = String(widget ?? "text").toLowerCase()
  if (raw === "derivedtext") return "derivedText"
  return isWidgetType(raw) ? raw : "text"
}

/** Engine keys copied onto a field as booleans, each only when present. `listColumn` wins over `showInList`. */
const FIELD_FLAGS = [
  ["showInList", "listColumn"],
  ["listColumn", "listColumn"],
  ["sortable", "sortable"],
  ["filterable", "filterable"],
  ["readOnly", "readOnly"],
  ["hidden", "hidden"],
  ["searchable", "searchable"],
] as const

function fieldFlags(fi: Record<string, unknown>): Partial<FieldConfig> {
  const flags: Partial<FieldConfig> = {}
  for (const [source, target] of FIELD_FLAGS) {
    if (fi[source] !== undefined) flags[target] = Boolean(fi[source])
  }
  return flags
}

function mapEngineField(fi: Record<string, unknown>): FieldConfig {
  const options = fi["options"]
  const validation = fi["validation"]
  return {
    name: String(fi["name"] ?? ""),
    label: String(fi["label"] ?? humanize(String(fi["name"] ?? ""))),
    widget: normalizeStudioWidget(fi["widget"]),
    required: Boolean(fi["required"] ?? false),
    localized: Boolean(fi["localized"] ?? false),
    ...fieldFlags(fi),
    ...(isJsonObject(options) && { options }),
    // The field's declared bounds, carried through rather than rebuilt. Studio checks these
    // before it sends a write, so a dropped `validation` is a form that accepts a value the
    // database is about to refuse, and a Rules tab that reports a bounded field as unbounded.
    ...(isFieldValidation(validation) && { validation }),
  }
}

export function mapEngineFields(rawFields: unknown): FieldConfig[] {
  return objectsIn(rawFields).map(mapEngineField)
}

/**
 * Model-level rules and declared indexes, carried through for the same reason as a field's bounds:
 * they are what the database enforces, and nothing else in Studio can derive them. Without these
 * the Rules tab reports a model with fourteen live check constraints as having none.
 */
function modelRules(mo: Record<string, unknown>): Pick<ModelConfig, "constraints" | "indexes"> {
  const constraints = mo["constraints"]
  const indexes = mo["indexes"]
  return {
    ...(Array.isArray(constraints) && { constraints: constraints.filter(isModelConstraint) }),
    ...(Array.isArray(indexes) && { indexes: indexes.filter(isModelIndex) }),
  }
}

const isEngineSort = isShape({ field: isString, direction: isOneOf(["asc", "desc"] as const) })

/**
 * A model's key and the order its list starts in.
 *
 * The engine sends every key column as `primaryKey`; an engine from before that sends none, and
 * its models are all keyed on `id`. A bare string is read as a one-column key. `defaultSort` was
 * sent all along and dropped here, so lists had no order until a header was clicked.
 */
function modelOrder(mo: Record<string, unknown>): Pick<ModelConfig, "primaryKey" | "primaryKeyColumns" | "defaultSort"> {
  const key = mo["primaryKey"]
  const columns = isStringArray(key) ? key : isString(key) ? [key] : undefined
  const sort = mo["defaultSort"]
  return {
    primaryKey: columns?.[0] ?? "id",
    ...(columns !== undefined && { primaryKeyColumns: columns }),
    ...(isEngineSort(sort) && { defaultSort: { column: sort.field, ascending: sort.direction === "asc" } }),
  }
}

function normalizeModel(mo: Record<string, unknown>): ModelConfig {
  const name = String(mo["name"] ?? "")
  const tableName = String(mo["tableName"] ?? name)
  const fields = mapEngineFields(mo["fields"])
  const listColumns = mo["listColumns"]
  const searchFields = mo["searchFields"]
  return {
    name,
    ...modelLabels(mo, name),
    tableName,
    apiPath: `/rest/v1/${tableName}`,
    ...modelOrder(mo),
    fields,
    listColumns: isStringArray(listColumns) ? listColumns : [],
    // A model may say which columns to search, or the columns may say it themselves with
    // `Searchable<T>`. The explicit list wins where it exists, because its order is meaningful
    // (the list view filters on the first), and the field flags are the fallback, so a schema
    // that only marks fields still gets a search box rather than silently getting none.
    searchFields: isStringArray(searchFields)
      ? searchFields
      : fields.filter((f) => f.searchable === true).map((f) => f.name),
    publishable: Boolean(mo["publishable"] ?? mo["publishing"] ?? false),
    versions: normalizeVersions(mo["versions"]),
    softDelete: Boolean(mo["softDelete"] ?? false),
    timestamps: Boolean(mo["timestamps"] ?? false),
    hasHooks: Boolean(mo["hasHooks"] ?? false),
    ...modelRules(mo),
  }
}

function normalizeGlobal(go: Record<string, unknown>): GlobalConfig {
  const name = String(go["name"] ?? "")
  const tableName = String(go["tableName"] ?? `_global_${toGlobalSuffix(name)}`)
  return {
    name,
    // One record, so only the singular override applies.
    label: nonEmptyString(go["label"]) ?? humanize(name),
    tableName,
    apiPath: `/rest/v1/${tableName}`,
    fields: mapEngineFields(go["fields"]),
  }
}

/** One item of an engine navigation group, resolved to the model or global it names. */
function navItem(i: Record<string, unknown>, models: ModelConfig[], globals: GlobalConfig[]): NavItem {
  const globalTable = String(i["global"] ?? "")
  if (globalTable) {
    const found = globals.find((gl) => gl.tableName === globalTable || gl.name === globalTable)
    return {
      label: found?.label ?? String(i["label"] ?? humanize(globalTable)),
      href: `/models/globals/${found?.name ?? globalTable}`,
      type: "global",
    }
  }
  const modelName = String(i["model"] ?? "")
  const found = models.find((mo) => mo.tableName === modelName || mo.name === modelName)
  // The model's own label wins over the item's. The engine names an item by its raw type name, so
  // preferring that would bring back "PlacesOfInterest" where the model already carries a readable
  // label.
  return {
    label: found?.labelPlural ?? String(i["label"] ?? humanize(modelName)),
    href: `/models/${found?.name ?? modelName}`,
    type: "model",
  }
}

/**
 * The sidebar: the engine's `{ group, items }` groups resolved against the models, groups already
 * in Studio's shape kept as they are, or one "Content" group listing every model.
 */
function normalizeNavigation(raw: unknown, models: ModelConfig[], globals: GlobalConfig[]): NavGroup[] {
  const rawNav = Array.isArray(raw) ? raw : []
  const first = rawNav[0]
  if (isJsonObject(first) && typeof first["group"] === "string") {
    return objectsIn(rawNav).map((gr) => ({
      label: String(gr["group"] ?? ""),
      items: objectsIn(gr["items"]).map((i) => navItem(i, models, globals)),
    }))
  }
  if (rawNav.length > 0) return rawNav.filter(isNavGroup)
  const items = models.map((mo): NavItem => ({ label: mo.labelPlural, href: `/models/${mo.name}`, type: "model" }))
  return [{ label: "Content", items }]
}

function normalizeLocale(raw: unknown): LocaleConfigAdmin | undefined {
  if (!isJsonObject(raw)) return undefined
  const locales = raw["locales"]
  return {
    locales: (isStringArray(locales) ? locales : ["en"]).map((code) => ({ code, label: code.toUpperCase() })),
    defaultLocale: String(raw["defaultLocale"] ?? "en"),
  }
}

/**
 * Where each model renders, when the project has said.
 *
 * Carried through explicitly, because this function is the boundary: the CLI writes a key into
 * `admin-config.json` and Studio only ever sees what is rebuilt here. A key added to the file and
 * not added here is not a broken feature with an error, it is a feature that silently does nothing,
 * which is how the live preview pane and every preview link were dead on self-host while the config
 * file on disk looked exactly right.
 *
 * Entries are filtered rather than trusted: a model naming neither an address nor a pattern
 * configures nothing, and keeping it would make Studio offer a share link that resolves nowhere.
 * Empty counts as absent, the same way the resolver treats it: a model whose only address is ""
 * names nowhere, and keeping it would put a share control on screen that mints a credential no link
 * can carry.
 */
function normalizeLivePreview(raw: unknown): Record<string, LivePreviewConfig> | undefined {
  if (!isJsonObject(raw)) return undefined
  const out: Record<string, LivePreviewConfig> = {}
  for (const [model, entry] of Object.entries(raw)) {
    if (!isJsonObject(entry)) continue
    const url = nonEmptyString(entry["url"])
    const urlPattern = nonEmptyString(entry["urlPattern"])
    if (url === undefined && urlPattern === undefined) continue
    out[model] = { ...(url !== undefined && { url }), ...(urlPattern !== undefined && { urlPattern }) }
  }
  return out
}

function normalizeAdminRoles(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((role): role is string => typeof role === "string" && role.length > 0)
}

/** Map engine admin-config.json to Studio {@link AdminConfig}. */
export function normalizeAdminConfig(raw: unknown): AdminConfig {
  const r = isJsonObject(raw) ? raw : {}
  const models = objectsIn(r["models"]).map(normalizeModel)
  const globals = objectsIn(r["globals"]).map(normalizeGlobal)
  const locale = normalizeLocale(r["localization"])
  const livePreview = normalizeLivePreview(r["livePreview"])
  const adminRoles = normalizeAdminRoles(r["adminRoles"])

  return {
    models,
    globals,
    navigation: normalizeNavigation(r["navigation"], models, globals),
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
  if (!isJsonObject(raw)) return null
  const versionsTable = raw["versionsTable"]
  if (typeof versionsTable !== "string" || versionsTable.length === 0) return null
  const keep = raw["keep"]
  const localizedColumns = raw["localizedColumns"]
  return {
    drafts: raw["drafts"] !== false,
    keep: typeof keep === "number" && keep >= 1 ? keep : 20,
    versionsTable,
    localizedColumns: Array.isArray(localizedColumns) ? localizedColumns.filter(isString) : [],
  }
}
