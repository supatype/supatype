/**
 * The columns a model's table holds that its declared fields do not name one for.
 *
 * The engine adds them: `timestamps: true` and `softDelete: true` in a model's options put
 * `created_at`, `updated_at` and `deleted_at` beside the fields (`option_columns` in the engine's
 * `generator/sql/migration.rs`), and the composite kinds `timestamps`, `publishable` and
 * `softDelete` stand for the columns they expand to. The engine's `database.ts` types all of them
 * (`generator/typescript/types.rs`). The client's augmentation and the hook types are built here from
 * the fields alone, so they left them out: 0.9.1 release test FF3, where `select("..., updated_at")`
 * failed `tsc` on a column the API returned.
 *
 * Each column is described as the field that would declare it, so every generator types it with its
 * own rules and the shapes match the engine's: filled by the database (optional on insert) where the
 * column is `NOT NULL DEFAULT`, nullable where it has no default.
 */

type FieldMeta = Record<string, unknown>

/** `TIMESTAMPTZ NOT NULL DEFAULT NOW()`: always on a row, never needed on insert. */
const FILLED_TIMESTAMP: FieldMeta = { kind: "datetime", required: true, serverGenerated: true }

/** A nullable `TIMESTAMPTZ` with no default. */
const NULLABLE_TIMESTAMP: FieldMeta = { kind: "datetime", required: false }

/** `status TEXT NOT NULL DEFAULT 'draft'`, checked against these four values. */
const PUBLISHABLE_STATUS: FieldMeta = {
  kind: "enum",
  values: ["draft", "published", "scheduled", "archived"],
  required: true,
  default: { kind: "value", value: "draft" },
}

/** The columns each composite kind expands to, in the order the engine writes them. */
const COMPOSITE_COLUMNS: Record<string, Array<[string, FieldMeta]>> = {
  timestamps: [
    ["created_at", FILLED_TIMESTAMP],
    ["updated_at", FILLED_TIMESTAMP],
  ],
  publishable: [
    ["status", PUBLISHABLE_STATUS],
    ["published_at", NULLABLE_TIMESTAMP],
    ["scheduled_at", NULLABLE_TIMESTAMP],
  ],
  softDelete: [["deleted_at", NULLABLE_TIMESTAMP]],
}

/** The columns a model's options add after its fields, skipping any a field already provides. */
function optionColumns(fields: Record<string, FieldMeta>, options: FieldMeta | undefined): Array<[string, FieldMeta]> {
  const has = (...names: string[]): boolean => names.some((name) => fields[name] !== undefined)
  const added: Array<[string, FieldMeta]> = []
  if (options?.["timestamps"] === true && !has("timestamps")) {
    if (!has("created_at", "createdAt")) added.push(["created_at", FILLED_TIMESTAMP])
    if (!has("updated_at", "updatedAt")) added.push(["updated_at", FILLED_TIMESTAMP])
  }
  if (options?.["softDelete"] === true && !has("softDelete", "deleted_at", "deletedAt")) {
    added.push(["deleted_at", NULLABLE_TIMESTAMP])
  }
  return added
}

/**
 * The model's fields as its table's columns: a composite replaced, where it is declared, by the
 * columns it expands to, and the columns its options add appended, as the engine orders them.
 */
export function columnFieldsOf(model: {
  fields: Record<string, FieldMeta>
  options?: FieldMeta | undefined
}): Record<string, FieldMeta> {
  const declared = Object.entries(model.fields).flatMap(([name, meta]): Array<[string, FieldMeta]> => {
    const kind = meta["kind"]
    const expanded = typeof kind === "string" ? COMPOSITE_COLUMNS[kind] : undefined
    return expanded ?? [[name, meta]]
  })
  return Object.fromEntries([...declared, ...optionColumns(model.fields, model.options)])
}
