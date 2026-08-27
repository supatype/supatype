import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { normalizeAdminConfig } from "../src/lib/normalize-admin-config.js"

/**
 * The rules have to survive normalization, which is where they were being lost.
 *
 * `normalizeAdminConfig` builds each model and field by naming the keys it copies, so a key the
 * engine adds is silently absent from Studio until it is named here too. Field bounds, model
 * constraints and indexes all arrived that way: the engine emitted them, the file on disk carried
 * them, and Studio dropped every one at this seam. The Rules tab showed a model with fourteen live
 * check constraints as having none, and the record editor stopped pre-checking bounds before a save.
 *
 * `model-rules.test.ts` did not catch it because it reads the engine fixture directly. Both are
 * needed: that one pins what the engine emits, this one pins that Studio still has it afterwards.
 */

const CONFIG_PATH = fileURLToPath(
  new URL("../../../tests/integration/.supatype/admin-config.json", import.meta.url),
)

const normalized = (): ReturnType<typeof normalizeAdminConfig> =>
  normalizeAdminConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")))

const probe = () => {
  const model = normalized().models.find((m) => m.tableName === "bounds_probe" || m.name === "boundsProbe")
  if (!model) throw new Error("boundsProbe is missing from the integration fixture")
  return model
}

describe("normalizing the engine's admin config", () => {
  it("keeps the bounds declared on a field", () => {
    const bounded = probe().fields.filter(
      (f) => f.validation !== undefined && Object.keys(f.validation).length > 0,
    )
    expect(
      bounded.length,
      "the fixture must declare a bound, or this test cannot fail",
    ).toBeGreaterThan(0)
  })

  it("keeps the model's constraints, with the rule Studio has to render", () => {
    const constraints = probe().constraints ?? []
    expect(constraints.length).toBeGreaterThan(0)
    for (const constraint of constraints) {
      expect(constraint.name).toBeTruthy()
      expect(constraint.rule, `${constraint.name} must carry its rule`).toBeDefined()
      expect(Array.isArray(constraint.columns)).toBe(true)
    }
  })

  it("keeps the model's indexes", () => {
    const indexes = probe().indexes ?? []
    expect(indexes.length).toBeGreaterThan(0)
    expect(indexes[0]?.name).toBeTruthy()
  })
})
