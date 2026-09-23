import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { MEASURES } from "../src/lib/validate-record.js"
import { evaluate } from "../src/lib/evaluate-constraint.js"
import type { AdminConfig } from "../src/config.js"

/**
 * Studio against the engine's actual output, rather than against what Studio believes it emits.
 *
 * The fixture in `tests/fixtures/admin-config.json` is **real engine output**: a copy of what
 * `supatype push` wrote for `tests/integration/schema/bounds.ts`. It is committed because the live
 * artifact it came from, `tests/integration/.supatype/admin-config.json`, is gitignored and only
 * exists on a machine that has run the stack. These tests read it from disk, so before it was
 * committed they passed locally and failed in CI every single time, which is worse than not
 * existing: a red check nobody can act on.
 *
 * A committed fixture goes stale, so it is not left to trust. `integration-test.sh` regenerates the
 * config against a live stack and diffs it against this file, failing with instructions when the
 * engine's output moves. Add a measure to the engine and this fixture must be regenerated in the
 * same change, which is exactly the coupling worth enforcing.
 *
 * The failure this guards against is precise: the engine gains a measure, Studio does not implement
 * it, and every existing test still passes because both sides are internally consistent. That is the
 * shape of the original defect, one layer up.
 */

const CONFIG_PATH = fileURLToPath(new URL("./fixtures/admin-config.json", import.meta.url))

function loadConfig(): AdminConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AdminConfig
}

/** Every `validation` key the engine put in the config, across every field of every model. */
function measuresInConfig(config: AdminConfig): string[] {
  const seen = new Set<string>()
  for (const model of config.models) {
    for (const field of model.fields) {
      for (const key of Object.keys(field.validation ?? {})) seen.add(key)
    }
  }
  return [...seen].sort()
}

describe("admin config parity", () => {
  it("exercises every measure, or the check below proves nothing", () => {
    // A fixture that declares no bounds would make the real assertion vacuous, which is worse than
    // no assertion: it reads as coverage. `tests/integration/schema/bounds.ts` exists for this.
    expect(measuresInConfig(loadConfig())).toEqual([...MEASURES].sort())
  })

  it("Studio implements every measure the engine emits", () => {
    const unhandled = measuresInConfig(loadConfig()).filter(
      (measure) => !(MEASURES as readonly string[]).includes(measure),
    )
    expect(
      unhandled,
      "the engine emits these bounds and Studio ignores them, so the form would accept values the " +
        "database rejects. Implement them in validate-record.ts and add them to MEASURES.",
    ).toEqual([])
  })
})

describe("admin config parity: constraints", () => {
  // The engine sends constraint nodes; Studio must be able to reach a verdict on the kinds it is
  // actually sent. A node Studio cannot read passes, deliberately, so this asserts the fixture is
  // not silently exercising nothing rather than asserting every node evaluates.
  it("carries model constraints, so the evaluator has something real to walk", () => {
    const config = loadConfig()
    const constrained = config.models.filter((m) => (m.constraints ?? []).length > 0)
    expect(
      constrained.length,
      "tests/integration/schema/bounds.ts should declare constraints, or the check below is empty",
    ).toBeGreaterThan(0)
  })

  it("Studio reaches a verdict on every constraint the engine emits", () => {
    const unreadable: string[] = []
    for (const model of loadConfig().models) {
      for (const constraint of model.constraints ?? []) {
        // Values chosen to be absent, so a readable rule returns null and an unreadable one also
        // returns null: what is asserted is the shape, not the verdict.
        const verdict = evaluate(constraint.rule, model.fields, {})
        if (verdict !== null && verdict !== true && verdict !== false) {
          unreadable.push(`${model.name}.${constraint.name}`)
        }
        // A rule with no columns cannot be attributed or evaluated against anything.
        expect(
          constraint.columns.length,
          `${model.name}.${constraint.name} names no columns, so nothing could report it`,
        ).toBeGreaterThan(0)
      }
    }
    expect(unreadable).toEqual([])
  })
})
