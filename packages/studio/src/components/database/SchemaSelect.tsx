import React from "react"
import type { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { Select } from "../ui.js"

/** The part of {@link useSchemaPicker} the picker reads and sets. */
export type SchemaChoice = Pick<ReturnType<typeof useSchemaPicker>, "schemas" | "schema" | "setSchema">

/**
 * The schema a Database screen lists, as the shared {@link Select}. Until the schema list arrives
 * it offers the one schema the screen is already showing.
 */
export function SchemaSelect({ picker }: { picker: SchemaChoice }): React.ReactElement {
  const { schemas, schema, setSchema } = picker
  return (
    <Select aria-label="Schema" value={schema} onChange={(e) => { setSchema(e.target.value) }}>
      {(schemas.length > 0 ? schemas : [schema]).map((s) => <option key={s} value={s}>{s}</option>)}
    </Select>
  )
}
