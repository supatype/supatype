/** Restore system relation targets (e.g. supatype:user) in engine-generated admin config. */

import { isJsonObject } from "@supatype/shared"
import { astModels, objectAt } from "./ast-read.js"

function fieldNameToForeignKey(fieldName: string): string {
  return fieldName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase() + "_id"
}

/** Each model's relations to a system target (`supatype:user`), by lowercased model name then foreign key. */
function systemRelationTargets(ast: unknown): Map<string, Map<string, string>> {
  const targets = new Map<string, Map<string, string>>()
  for (const model of astModels(ast)) {
    const name = model["name"]
    if (typeof name !== "string") continue
    for (const [fieldName, field] of Object.entries(objectAt(model, "fields") ?? {})) {
      const target = isJsonObject(field) && field["kind"] === "relation" ? field["target"] : undefined
      if (typeof target !== "string" || !target.includes(":")) continue
      const forModel = targets.get(name.toLowerCase()) ?? new Map<string, string>()
      targets.set(name.toLowerCase(), forModel)
      forModel.set(fieldNameToForeignKey(fieldName), target)
    }
  }
  return targets
}

/** Put the system target back on one admin-config relation field whose foreign key names one. */
function restoreTarget(field: unknown, modelTargets: ReadonlyMap<string, string>): void {
  if (!isJsonObject(field) || field["widget"] !== "relation") return
  const options = field["options"]
  if (!isJsonObject(options)) return
  const explicitFk = typeof options["foreignKey"] === "string" ? options["foreignKey"] : ""
  const fk = explicitFk || fieldNameToForeignKey(typeof field["name"] === "string" ? field["name"] : "")
  const systemTarget = modelTargets.get(fk)
  if (systemTarget) options["target"] = systemTarget
}

export function restoreSystemRelationTargets(admin: unknown, ast: unknown): void {
  const adminModels = isJsonObject(admin) ? admin["models"] : undefined
  if (!Array.isArray(adminModels)) return
  const systemTargets = systemRelationTargets(ast)
  for (const model of adminModels) {
    const tableName = isJsonObject(model) ? model["tableName"] : undefined
    const modelTargets = typeof tableName === "string" ? systemTargets.get(tableName) : undefined
    const fields = isJsonObject(model) ? model["fields"] : undefined
    if (!modelTargets || !Array.isArray(fields)) continue
    for (const field of fields) restoreTarget(field, modelTargets)
  }
}
