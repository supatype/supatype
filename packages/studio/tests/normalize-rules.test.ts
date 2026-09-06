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
  new URL("./fixtures/admin-config.json", import.meta.url),
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

describe("what crosses the CLI to Studio boundary", () => {
  // This function is the boundary. The CLI writes keys into `admin-config.json`; Studio only ever
  // sees what is rebuilt here. A key added to the file and not added here is not a broken feature
  // with an error, it is a feature that silently does nothing.
  //
  // That is exactly what happened: `livePreview` was written by the CLI, asserted present in the
  // file by a CLI test, and dropped here. The live preview pane and every preview link were dead on
  // self-host while the config on disk looked perfectly correct, and nothing on either side failed.

  const base = { models: [], globals: [], navigation: [] }

  it("carries livePreview through, since Studio cannot see the file", () => {
    const out = normalizeAdminConfig({
      ...base,
      livePreview: { Post: { urlPattern: "/preview/{slug}" } },
    })
    expect(out.livePreview).toEqual({ Post: { urlPattern: "/preview/{slug}" } })
  })

  it("keeps both an address and a pattern when a model gives both", () => {
    const out = normalizeAdminConfig({
      ...base,
      livePreview: { Post: { url: "https://example.com", urlPattern: "/p/{slug}" } },
    })
    expect(out.livePreview?.["Post"]).toEqual({
      url: "https://example.com",
      urlPattern: "/p/{slug}",
    })
  })

  it("drops an entry that names neither, rather than offering a link to nowhere", () => {
    const out = normalizeAdminConfig({ ...base, livePreview: { Post: {}, Page: { url: "" } } })
    expect(out.livePreview).toBeUndefined()
  })

  it("ignores rubbish in the file without taking the rest of the config down", () => {
    // The file is generated, but it is also on disk where anyone can edit it.
    const out = normalizeAdminConfig({
      ...base,
      livePreview: { Post: { urlPattern: 42 }, Page: { urlPattern: "/ok" } },
    })
    expect(out.livePreview).toEqual({ Page: { urlPattern: "/ok" } })
  })

  it("says nothing when the project configured nothing", () => {
    expect(normalizeAdminConfig(base).livePreview).toBeUndefined()
  })
})
