import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { denoServeEnv, serveDisplayUrl } from "../src/commands/functions.js"
import { assertEngineVersionSupported } from "../src/engine-floor.js"
import { generateFunctionsRouterSource } from "../src/functions-router-gen.js"
import { localLinkLabel } from "../src/local-gateway.js"
import { databaseStateToSchemaScaffold } from "../src/pull-utils.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"
import { projectConfig } from "./support/project-config.js"
import { serveCommand } from "./support/serve-command.js"

/** Local test round 3b: the smaller findings, each shown failing before its fix. */
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-3b-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("st link's field label", () => {
  it("names the server for a native project and the gateway for a docker one", () => {
    expect(localLinkLabel(projectConfig({ provider: "native" }))).toBe("Server URL")
    expect(localLinkLabel(projectConfig({ provider: "docker" }))).toBe("Kong gateway URL")
  })
})

describe("pull's RLS TODO", () => {
  it("names policy commands as SQL does, not by Postgres's letters", () => {
    const table = { name: "posts", columns: [{ name: "id", dataType: "uuid", udtName: "uuid", nullable: false }] }
    const rlsPolicies = ["r", "a", "w", "d", "*"].map((command, i) => ({ table: "posts", name: `p${i}`, command }))
    const draft = databaseStateToSchemaScaffold({ tables: [table], rlsPolicies })
    expect(draft).toContain('"p0" (SELECT), "p1" (INSERT), "p2" (UPDATE), "p3" (DELETE), "p4" (ALL)')
  })
})

describe("functions serve's address", () => {
  it("listens on 127.0.0.1 unless told otherwise", () => {
    const router = generateFunctionsRouterSource("/project/.supatype/functions-router.ts", [])
    expect(router).toContain('const hostname = Deno.env.get("SUPATYPE_FUNCTIONS_HOST") ?? "127.0.0.1"')
    expect(router).toMatch(/Deno\.serve\(\{\s*hostname,\s*port,/)
  })

  it("takes --host, defaulting to 127.0.0.1, and hands it to Deno", () => {
    expect(serveCommand()?.options.find((o) => o.long === "--host")?.defaultValue).toBe("127.0.0.1")
    const env = denoServeEnv(dir, join(dir, "functions"), projectConfig(), { port: "18472", host: "0.0.0.0" })
    expect(env["SUPATYPE_FUNCTIONS_HOST"]).toBe("0.0.0.0")
  })
})

describe("a bucket's maxSize", () => {
  function extract(maxSize: string): () => unknown {
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `import type { Model, UUID, ImageAsset, Bucket } from "@supatype/types"
export type big = Bucket<"big", { maxSize: "${maxSize}" }>
export type Post = Model<{ id: UUID; photo: ImageAsset<big> }>
`,
      "utf8",
    )
    return () => extractSchemaAstFromTypes(schemaPath, dir)
  }

  it("says a size of a valid form is too big, and gives the limit", () => {
    expect(extract("90000000000GB")).toThrow(/maxSize "90000000000GB" is too big: the largest is 8388607GB/)
  })

  it("names the units it reads when the unit is not one of them", () => {
    expect(extract("9000000TB")).toThrow(/"TB" is not a size unit here: use B, KB, MB or GB/)
  })
})

describe("the engine floor's advice", () => {
  it("tells a host binary to pin a version, without naming an image", () => {
    expect(() => assertEngineVersionSupported("0.7.0", "versions.engine in supatype.config.ts", "binary")).toThrow(
      /^(?!.*SUPATYPE_ENGINE_IMAGE).*Pin versions\.engine to 0\.8\.0 or newer/s,
    )
  })

  it("tells an image to name a newer image or pin a version", () => {
    expect(() => assertEngineVersionSupported("0.7.0", "SUPATYPE_ENGINE_IMAGE", "image")).toThrow(/SUPATYPE_ENGINE_IMAGE/)
  })
})

describe("functions serve's announced address", () => {
  it("names localhost for a wildcard bind, and brackets an IPv6 host", () => {
    expect(serveDisplayUrl("127.0.0.1", "18472")).toBe("http://127.0.0.1:18472/functions/v1/")
    expect(serveDisplayUrl("0.0.0.0", "18472")).toBe("http://localhost:18472/functions/v1/")
    expect(serveDisplayUrl("::", "18472")).toBe("http://localhost:18472/functions/v1/")
    expect(serveDisplayUrl("::1", "18472")).toBe("http://[::1]:18472/functions/v1/")
  })
})

describe("an IPv6 --host given in brackets", () => {
  it("is announced with one pair of brackets, and handed to Deno without them", () => {
    expect(serveDisplayUrl("[::1]", "18472")).toBe("http://[::1]:18472/functions/v1/")
    expect(serveDisplayUrl("[::]", "18472")).toBe("http://localhost:18472/functions/v1/")
    const env = denoServeEnv(dir, join(dir, "functions"), projectConfig(), { port: "18472", host: "[::1]" })
    expect(env["SUPATYPE_FUNCTIONS_HOST"]).toBe("::1")
  })
})
