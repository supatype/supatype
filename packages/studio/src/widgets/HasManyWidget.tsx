import React, { useEffect, useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import type { FieldConfig, ModelConfig } from "../config.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { isJsonObject } from "../lib/json.js"
import { foreignKeyColumn } from "../lib/recordValues.js"
import { RelationWidget } from "./RelationWidget.js"
import type { WidgetProps } from "./FieldWidget.js"

/** Whether a field is the "many" side of a one-to-many relation, which has no column of its own. */
export function isHasMany(config: FieldConfig): boolean {
  return config.widget === "multirelation" && config.options?.["cardinality"] === "hasMany"
}

/** Where a has-many field's rows live: the other model, and its column that points back. */
interface HasManySource {
  target: ModelConfig
  foreignKey: string
  ownerKey: string
}

const modelFor = (models: readonly ModelConfig[], table: unknown): ModelConfig | undefined =>
  models.find((m) => m.tableName === table || m.name === table)

/**
 * The model a has-many field reads and the belongs-to column on it that points back at the owner.
 * Undefined when the config does not settle it: no owner, or more than one column could be the one.
 */
export function hasManySource(models: readonly ModelConfig[], config: FieldConfig): HasManySource | undefined {
  const target = modelFor(models, config.options?.["target"])
  const owners = models.filter((m) => m.fields.some((f) => f.name === config.name && isHasMany(f) && modelFor(models, f.options?.["target"]) === target))
  const owner = owners.length === 1 ? owners[0] : undefined
  if (target === undefined || owner === undefined) return undefined
  const back = target.fields.filter((f) => foreignKeyColumn(f) !== undefined && modelFor(models, f.options?.["target"]) === owner)
  const foreignKey = back.length === 1 && back[0] !== undefined ? foreignKeyColumn(back[0]) : undefined
  return foreignKey === undefined ? undefined : { target, foreignKey, ownerKey: owner.primaryKey }
}

/** The rows a has-many field lists: `table`'s rows whose `foreignKey` is `ownerId`, by their `key`. */
interface RelatedRows {
  table: string
  key: string
  foreignKey: string
  ownerId: string
}

/** The keys of the related rows, or null when they could not be read. */
async function relatedIds(client: SupatypeClient, { table, key, foreignKey, ownerId }: RelatedRows): Promise<string[] | null> {
  try {
    const result = await client.from(table).select(key).eq(foreignKey, ownerId)
    const rows: unknown = result.data
    if (result.error !== null || !Array.isArray(rows)) return null
    return rows.filter(isJsonObject).map((row) => String(row[key]))
  } catch {
    return null
  }
}

/**
 * A has-many field: the rows on the other side whose foreign key names this record, read from that
 * table because the record itself holds no column for them. Read only, since each row's link is
 * written on that row; an unsaved record has none yet.
 */
export function HasManyWidget(props: WidgetProps): React.ReactElement {
  const client = useAdminClient()
  const source = hasManySource(useAdminConfig().models, props.config)
  const ownerValue = source === undefined ? undefined : props.record?.[source.ownerKey]
  const ownerId = ownerValue === undefined || ownerValue === null ? null : String(ownerValue)
  const [ids, setIds] = useState<string[]>([])

  // Primitives, not `source`: it is derived afresh from the config on every render.
  const table = source?.target.tableName
  const key = source?.target.primaryKey
  const foreignKey = source?.foreignKey

  useEffect(() => {
    if (table === undefined || key === undefined || foreignKey === undefined || ownerId === null) return
    let cancelled = false
    void relatedIds(client, { table, key, foreignKey, ownerId }).then((found) => {
      if (!cancelled && found !== null) setIds(found)
    })
    return () => {
      cancelled = true
    }
  }, [client, table, key, foreignKey, ownerId])

  return <RelationWidget {...props} value={ids} readOnly />
}
