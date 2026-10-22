import { describe, expect, it } from "vitest"
import { generateProjectClient } from "../src/client-generator.js"
import { projectClientImportPath } from "../src/type-generation.js"

/**
 * Fresh-user test C29: the generated client told you to import from "./supatype/client" while it
 * was written to supatype/generated/client.ts, so the import it suggested did not resolve. The
 * comment now names the path the file is written to.
 */
describe("generated client header", () => {
  it("names the default path the client is written to", () => {
    expect(projectClientImportPath("supatype/generated/index.d.ts")).toBe("./supatype/generated/client")
    const client = generateProjectClient({ models: [] }, projectClientImportPath("supatype/generated/index.d.ts"))
    expect(client).toContain('import { createClient } from "./supatype/generated/client"')
    expect(client).not.toContain('from "./supatype/client"')
  })

  it("follows a configured output path, with forward slashes", () => {
    expect(projectClientImportPath(["src", "gen", "types.d.ts"].join("\\"))).toBe("./src/gen/client")
  })
})
