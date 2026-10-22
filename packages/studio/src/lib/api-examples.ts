import type { FieldConfig } from "../config.js"
import { stringOption } from "../widgets/field-options.js"

const EXAMPLE_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

/** A stored file as its column holds it: the storage reference the image and file widgets write. */
function storageRefExample(f: FieldConfig, fallbackBucket: string, file: { ext: string; mimeType: string }): unknown {
  const bucket = stringOption(f, "bucket") ?? fallbackBucket
  return { bucket, path: `example/${f.name}.${file.ext}`, mimeType: file.mimeType, size: 48213 }
}

/** A rich text column holds a Lexical document, not a string. */
const RICH_TEXT_EXAMPLE = {
  root: {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", text: "Example text" }] }],
  },
}

/** The example a docs page shows for one field's value. */
export function exampleValue(f: FieldConfig): unknown {
  switch (f.widget) {
    case "uuid": case "relation": case "multirelation": return EXAMPLE_UUID
    case "number": return 1
    case "boolean": case "publish": return true
    case "datetime": return "2026-01-15T10:30:00Z"
    case "date": return "2026-01-15"
    case "json": case "blocks": return {}
    case "image": return storageRefExample(f, "images", { ext: "png", mimeType: "image/png" })
    case "file": return storageRefExample(f, "files", { ext: "pdf", mimeType: "application/pdf" })
    case "richtext": return RICH_TEXT_EXAMPLE
    default: return `example_${f.name}`
  }
}

/** The example as a parameter table shows it: an object as its JSON rather than "[object Object]". */
export function exampleText(f: FieldConfig): string {
  const value = exampleValue(f)
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)
}

/**
 * Whether a field is a column of the row. A has-many or many-to-many relation is not: its rows live
 * in another table or a junction, and a plain read or write of this table neither returns nor takes it.
 */
export function isRowColumn(f: FieldConfig): boolean {
  return f.widget !== "multirelation"
}

/** An example row or body holding `fields`, as the REST API reads and writes it. */
export function exampleRecord(fields: readonly FieldConfig[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const f of fields) if (isRowColumn(f)) obj[f.name] = exampleValue(f)
  return obj
}
