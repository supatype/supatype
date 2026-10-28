import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * A colon is a legal file name on macOS and Linux, and Windows cannot create one, so the graph is
 * stubbed: the name is what matters, and restore refuses it on every platform.
 */
vi.mock("../src/type-extractor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/type-extractor.js")>()),
  collectSchemaSourcePaths: (_entry: string, root: string) => ({
    entryPoint: "schema/index.ts",
    files: [
      {
        relativePath: "schema/models/v1:legacy.ts",
        absolutePath: join(root, "schema", "index.ts"),
        sha256: "0",
        bytes: 1,
      },
    ],
  }),
}))

const { buildSchemaSourcesPayload, writeSchemaSourcePushArtifacts } = await import("../src/schema-sources.js")

let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schema-sources-dev-"))
  mkdirSync(join(dir, "schema"))
  writeFileSync(join(dir, "schema", "index.ts"), "export {}\n")
  writeFileSync(
    join(dir, "supatype.config.ts"),
    `export default ${JSON.stringify({
      project: { name: "demo" },
      database: { provider: "docker" },
      server: { mode: "dev" },
      app: { mode: "none" },
      schema: { path: "schema/index.ts", pg_schema: "public" },
    })}\n`,
  )
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("a schema file name a snapshot cannot restore", () => {
  it("stops supatype push, through the control plane or the project's own engine", () => {
    expect(() => buildSchemaSourcesPayload(dir, "a@example.com")).toThrow(/cannot restore/)
    expect(() => writeSchemaSourcePushArtifacts(dir, false)).toThrow(/cannot restore/)
  })

  it("costs dev's push its snapshot, with a warning, rather than stopping every save", () => {
    expect(writeSchemaSourcePushArtifacts(dir, true)).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("keeps no schema snapshot"))
  })
})
