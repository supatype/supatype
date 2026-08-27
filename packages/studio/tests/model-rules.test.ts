import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { describeConstraint } from "../src/lib/evaluate-constraint.js"
import type { AdminConfig, FieldConfig } from "../src/config.js"

/**
 * What the Rules tab has to render, read from the engine's real output.
 *
 * These rules are otherwise invisible until they fire: a bound is a rejected save, an index is a
 * query that is unexpectedly fast or slow. The tab is the only place they are legible, so the shape
 * it reads from is worth pinning against what the engine actually produces rather than against a
 * hand-written fixture that could drift into agreeing with the view and not the engine.
 */

const CONFIG_PATH = fileURLToPath(
  new URL("../../../tests/integration/.supatype/admin-config.json", import.meta.url),
)

const config = (): AdminConfig =>
  JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AdminConfig

const probe = (): AdminConfig["models"][number] => {
  const model = config().models.find((m) => m.name === "boundsProbe")
  if (!model) throw new Error("boundsProbe is missing from the integration fixture")
  return model
}

describe("the Rules tab renders what the engine emits", () => {
  it("finds declared indexes, with the name the engine resolved", () => {
    const indexes = probe().indexes ?? []
    expect(
      indexes.length,
      "the fixture should declare an index, or the index section is never exercised",
    ).toBeGreaterThan(0)

    const [index] = indexes
    // The name is resolved by the engine, not invented by Studio: an author who declares no name
    // still needs the one Postgres will carry, because that is what a `\\d` shows them.
    expect(index?.name).toMatch(/_idx$/)
    expect(index?.fields.length).toBeGreaterThan(0)
    expect(typeof index?.unique).toBe("boolean")
    expect(index?.using).toBe("btree")
  })

  it("describes every constraint in words, with no node left unreadable", () => {
    const model = probe()
    const unreadable = (model.constraints ?? []).filter((constraint) => {
      const words = describeConstraint(constraint.rule, model.fields, {})
      // The fallbacks the renderer falls back to when it meets a node it cannot phrase. Showing one
      // of those in a table of rules is worse than showing nothing: it looks like the rule itself.
      return words === "this rule must hold" || words.includes("this value")
    })
    expect(unreadable.map((c) => c.name)).toEqual([])
  })

  it("names fields by their label, so the tab reads as the form does", () => {
    const model = probe()
    const cross = (model.constraints ?? []).find((c) => c.columns.length > 1)
    expect(cross, "the fixture should carry a cross-column rule").toBeDefined()

    const words = describeConstraint(cross!.rule, model.fields, {})
    const labels = model.fields
      .filter((f: FieldConfig) => cross!.columns.includes(f.name))
      .map((f: FieldConfig) => f.label)
    for (const label of labels) {
      expect(words, `a cross-column rule should name ${label}`).toContain(label)
    }
  })

  it("carries bounds on the fields, which is the third thing the tab lists", () => {
    const bounded = probe().fields.filter(
      (f: FieldConfig) => f.validation !== undefined && Object.keys(f.validation).length > 0,
    )
    expect(bounded.length).toBeGreaterThan(0)
  })
})
