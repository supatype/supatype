/** Restore system relation targets (e.g. supatype:user) in engine-generated admin config. */

function fieldNameToForeignKey(fieldName: string): string {
  return fieldName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase() + "_id"
}

export function restoreSystemRelationTargets(admin: unknown, ast: unknown): void {
  if (typeof admin !== "object" || admin === null || typeof ast !== "object" || ast === null) return
  const astObj = ast as { models?: Array<{ name: string; fields?: Record<string, { kind: string; target?: string }> }> }
  if (!astObj.models) return
  const cfg = admin as {
    models?: Array<{
      tableName: string
      fields: Array<{ name: string; widget: string; options?: Record<string, unknown> }>
    }>
  }
  if (!Array.isArray(cfg.models)) return

  const systemTargets = new Map<string, Map<string, string>>()
  for (const model of astObj.models) {
    if (!model.fields) continue
    for (const [fieldName, field] of Object.entries(model.fields)) {
      if (field.kind === "relation" && field.target?.includes(":")) {
        const key = model.name.toLowerCase()
        if (!systemTargets.has(key)) systemTargets.set(key, new Map())
        systemTargets.get(key)!.set(fieldNameToForeignKey(fieldName), field.target)
      }
    }
  }

  for (const model of cfg.models) {
    const modelTargets = systemTargets.get(model.tableName)
    if (!modelTargets) continue
    for (const field of model.fields) {
      if (field.widget !== "relation" || !field.options) continue
      const explicitFk = (field.options["foreignKey"] as string) ?? ""
      const fk = explicitFk || fieldNameToForeignKey(field.name)
      const systemTarget = modelTargets.get(fk)
      if (systemTarget) field.options["target"] = systemTarget
    }
  }
}
