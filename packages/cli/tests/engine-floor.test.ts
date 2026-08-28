import { describe, expect, it } from "vitest"
import {
  assertEngineSupportsSchema,
  boundsRequiringHelpers,
  compareVersions,
  ENGINE_MIN_FOR_BOUNDS,
} from "../src/engine-floor.js"
import type { ExtractedSchemaAstV2, FieldAstV2, ModelAstV2 } from "../src/schema-ast-v2.js"

function field(overrides: Partial<FieldAstV2> = {}): FieldAstV2 {
  return {
    kind: "text",
    annotations: { db: { pgType: "TEXT" }, platform: {} },
    ...overrides,
  } as FieldAstV2
}

function model(name: string, fields: Record<string, FieldAstV2>, constraints?: unknown[]): ModelAstV2 {
  return {
    name,
    fields,
    options: {},
    annotations: {
      db: { tableName: name.toLowerCase(), indexes: [], ...(constraints && { constraints }) },
      platform: { access: {} },
    },
  }
}

function schema(models: ModelAstV2[]): ExtractedSchemaAstV2 {
  return { astVersion: 2, models } as ExtractedSchemaAstV2
}

const WITH_BOUND = schema([model("Post", { title: field({ validation: { maxLength: 80 } }) })])
const WITHOUT_BOUND = schema([model("Post", { title: field() })])

describe("compareVersions", () => {
  it("orders by each numeric part, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0)
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0)
    expect(compareVersions("0.1.9", "0.2.0")).toBeLessThan(0)
  })

  it("ignores a leading v and a pre-release suffix", () => {
    // A release candidate of the engine that creates the helpers does create them.
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0)
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(0)
  })
})

describe("boundsRequiringHelpers", () => {
  it("names the fields that declare a bound", () => {
    expect(boundsRequiringHelpers(WITH_BOUND)).toEqual(["Post.title"])
  })

  it("names models carrying a constraint", () => {
    const ast = schema([model("Event", { start: field() }, [{ expr: "start < finish" }])])
    expect(boundsRequiringHelpers(ast)).toEqual(["Event"])
  })

  it("is empty for a schema that declares neither", () => {
    expect(boundsRequiringHelpers(WITHOUT_BOUND)).toEqual([])
  })
})

describe("assertEngineSupportsSchema", () => {
  it("refuses a bound schema on an engine below the floor", () => {
    expect(() => assertEngineSupportsSchema(WITH_BOUND, "0.1.9")).toThrow(/schema-engine 0\.2\.0 or newer/)
  })

  it("names the pin and the field, so the message is actionable", () => {
    try {
      assertEngineSupportsSchema(WITH_BOUND, "0.1.9")
      expect.unreachable("should have refused")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toContain("pins 0.1.9")
      expect(message).toContain("Post.title")
      expect(message).toContain("versions: { engine:")
    }
  })

  // The three cases where refusing would be worse than the failure it prevents: an old pin is
  // fine without bounds, an unpinned project resolves to latest, and `local` cannot be compared.
  it("allows an old pin when the schema declares no bounds", () => {
    expect(() => assertEngineSupportsSchema(WITHOUT_BOUND, "0.1.9")).not.toThrow()
  })

  it("allows an unpinned project", () => {
    expect(() => assertEngineSupportsSchema(WITH_BOUND, undefined)).not.toThrow()
  })

  it("allows a local override, whose version the config does not know", () => {
    expect(() => assertEngineSupportsSchema(WITH_BOUND, "local")).not.toThrow()
  })

  it("allows the floor itself and anything above it", () => {
    expect(() => assertEngineSupportsSchema(WITH_BOUND, ENGINE_MIN_FOR_BOUNDS)).not.toThrow()
    expect(() => assertEngineSupportsSchema(WITH_BOUND, "0.3.1")).not.toThrow()
    expect(() => assertEngineSupportsSchema(WITH_BOUND, "1.0.0")).not.toThrow()
  })
})
