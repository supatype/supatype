import { describe, expect, it } from "vitest"
import {
  assertEngineSupportsSchema,
  boundsRequiringHelpers,
  compareVersions,
  ENGINE_MIN_FOR_BOUNDS,
  ENGINE_MIN_FOR_RICHTEXT_TRIGGER,
  ENGINE_MIN_FOR_SEED,
  ENGINE_MIN_FOR_VERSIONS,
  fieldsNeedingRichTextTrigger,
  modelsRequiringVersions,
  seedUnsupportedByPinnedEngine,
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

const RICH_TEXT = field({ kind: "richText", annotations: { db: { pgType: "JSONB" }, platform: {} } })
const WITH_RICH_TEXT = schema([model("Post", { title: field(), body: RICH_TEXT })])

/** The engine released before either floor, so it is what a project pinned today would carry. */
const BEFORE_BOTH = "0.3.3"

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

describe("the versions floor", () => {
  const versionedModel = (): ModelAstV2 => ({
    ...model("Post", { title: field() }),
    options: { versions: { drafts: true, keep: 20 } },
  })
  const VERSIONED = schema([versionedModel()])
  const PLAIN = schema([model("Post", { title: field() })])

  it("names the models that declare it", () => {
    expect(modelsRequiringVersions(VERSIONED)).toEqual(["Post"])
    expect(modelsRequiringVersions(PLAIN)).toEqual([])
  })

  it("refuses a pin older than the release that emits the layer", () => {
    // The failure this guards is *silent*: an older engine does not reject `versions`, it ignores
    // the key, so the push reports success and the model has no snapshot table and no drafts.
    expect(() => { assertEngineSupportsSchema(VERSIONED, "0.2.0") }).toThrow(
      /`versions`[\s\S]*0\.3\.0[\s\S]*saves into nothing/,
    )
  })

  it("allows the release itself and anything newer", () => {
    expect(() => { assertEngineSupportsSchema(VERSIONED, ENGINE_MIN_FOR_VERSIONS) }).not.toThrow()
    expect(() => { assertEngineSupportsSchema(VERSIONED, "1.0.0") }).not.toThrow()
  })

  it("says nothing about a schema that declares no versions", () => {
    // The floor must not spread to projects that never asked for the feature.
    expect(() => { assertEngineSupportsSchema(PLAIN, "0.1.0") }).not.toThrow()
  })

  it("leaves an unpinned or local project alone", () => {
    expect(() => { assertEngineSupportsSchema(VERSIONED, undefined) }).not.toThrow()
    expect(() => { assertEngineSupportsSchema(VERSIONED, "local") }).not.toThrow()
  })

  it("still refuses bounds on an older pin, so the second rule did not shadow the first", () => {
    expect(() => { assertEngineSupportsSchema(WITH_BOUND, "0.1.9") }).toThrow(/bounds/)
  })
})

describe("the rich text trigger floor", () => {
  it("names the columns that need it", () => {
    expect(fieldsNeedingRichTextTrigger(WITH_RICH_TEXT)).toEqual(["Post.body"])
    expect(fieldsNeedingRichTextTrigger(WITHOUT_BOUND)).toEqual([])
  })

  it("refuses a rich text column on an engine that cannot normalise it", () => {
    expect(() => { assertEngineSupportsSchema(WITH_RICH_TEXT, BEFORE_BOTH) }).toThrow(
      new RegExp(`schema-engine ${ENGINE_MIN_FOR_RICHTEXT_TRIGGER.replace(/\./g, "\.")} or newer`),
    )
  })

  it("points at the column, because the remedy is in the schema", () => {
    try {
      assertEngineSupportsSchema(WITH_RICH_TEXT, BEFORE_BOTH)
      expect.unreachable("a rich text column on an older engine has to be refused")
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain("Post.body")
      expect(message).toContain("rich text columns")
      // The whole point of the refusal: what goes wrong is a read, not the push.
      expect(message).toContain("what the types say is impossible")
      expect(message).toContain(`versions: { engine: "${ENGINE_MIN_FOR_RICHTEXT_TRIGGER}" }`)
    }
  })

  it("allows the release itself and anything newer", () => {
    expect(() => {
      assertEngineSupportsSchema(WITH_RICH_TEXT, ENGINE_MIN_FOR_RICHTEXT_TRIGGER)
    }).not.toThrow()
    expect(() => { assertEngineSupportsSchema(WITH_RICH_TEXT, "1.0.0") }).not.toThrow()
  })

  it("says nothing about a schema with no rich text column", () => {
    expect(() => { assertEngineSupportsSchema(WITHOUT_BOUND, BEFORE_BOTH) }).not.toThrow()
  })

  it("leaves an unpinned or local project alone", () => {
    expect(() => { assertEngineSupportsSchema(WITH_RICH_TEXT, undefined) }).not.toThrow()
    expect(() => { assertEngineSupportsSchema(WITH_RICH_TEXT, "local") }).not.toThrow()
  })
})

describe("seedUnsupportedByPinnedEngine", () => {
  it("refuses a pin with no seed subcommand, and says what to change", () => {
    const message = seedUnsupportedByPinnedEngine(BEFORE_BOTH)
    expect(message).toBeDefined()
    expect(message).toContain(`schema-engine ${ENGINE_MIN_FOR_SEED} or newer`)
    expect(message).toContain(BEFORE_BOTH)
    expect(message).toContain(`versions: { engine: "${ENGINE_MIN_FOR_SEED}" }`)
  })

  it("allows the release itself and anything newer", () => {
    expect(seedUnsupportedByPinnedEngine(ENGINE_MIN_FOR_SEED)).toBeUndefined()
    expect(seedUnsupportedByPinnedEngine("1.0.0")).toBeUndefined()
  })

  it("leaves an unpinned or local project alone", () => {
    // Unpinned resolves to latest, which is at or above the floor by definition.
    expect(seedUnsupportedByPinnedEngine(undefined)).toBeUndefined()
    expect(seedUnsupportedByPinnedEngine("local")).toBeUndefined()
  })

  it("is not conditional on the schema, because every seed needs the subcommand", () => {
    // No argument but the pin: there is nothing a project could declare to opt out of this one,
    // which is what makes it different from every other floor in this file.
    expect(seedUnsupportedByPinnedEngine.length).toBe(1)
  })
})

describe("the floors themselves", () => {
  it("name the engine release that introduced them", () => {
    // Hard-coded rather than read back from the constant. Every other assertion in this file
    // builds its expectation from the value under test, so lowering a floor would move the tests
    // with it and nothing would go red. A floor is a reviewed claim about a published engine, and
    // this is the one place that says which one.
    expect(ENGINE_MIN_FOR_BOUNDS).toBe("0.2.0")
    expect(ENGINE_MIN_FOR_VERSIONS).toBe("0.3.0")
    expect(ENGINE_MIN_FOR_RICHTEXT_TRIGGER).toBe("0.4.0")
    expect(ENGINE_MIN_FOR_SEED).toBe("0.4.0")
  })
})
