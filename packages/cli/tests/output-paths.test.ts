/**
 * Where `dev`, `push` and `generate` write the generated types and client.
 *
 * `dev` and `push` wrote them only when the project set `output`, and `init` set none, so in a new
 * project a renamed field left the typed client describing a column that no longer existed: the
 * app kept compiling and failed at runtime. All three now resolve the same paths, falling back to
 * the defaults `generate` always used.
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_CLIENT_PATH, DEFAULT_TYPES_PATH, projectOutputPaths } from "../src/type-generation.js"

describe("projectOutputPaths()", () => {
  it("falls back to the defaults when the project sets no output", () => {
    expect(projectOutputPaths(undefined)).toEqual({ typesPath: "types/database.ts", clientPath: "supatype/generated/index.d.ts" })
    expect(projectOutputPaths({})).toEqual({ typesPath: DEFAULT_TYPES_PATH, clientPath: DEFAULT_CLIENT_PATH })
  })

  it("keeps what the project set, each path on its own", () => {
    expect(projectOutputPaths({ types: "src/db.ts" })).toEqual({ typesPath: "src/db.ts", clientPath: DEFAULT_CLIENT_PATH })
    expect(projectOutputPaths({ types: "a.ts", client: "gen/index.d.ts" })).toEqual({
      typesPath: "a.ts",
      clientPath: "gen/index.d.ts",
    })
  })

  it("treats a blank path as unset rather than writing to the project root", () => {
    expect(projectOutputPaths({ types: "  ", client: "" })).toEqual({ typesPath: DEFAULT_TYPES_PATH, clientPath: DEFAULT_CLIENT_PATH })
  })
})
