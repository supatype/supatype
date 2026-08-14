import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { serviceRoleRoutesFor } from "../src/commands/functions.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/** A config the loader accepts, plus whatever the test is actually about. */
function projectWith(extra: Record<string, unknown>): string {
  const cwd = mkdtempSync(join(tmpdir(), "supatype-svcrole-"))
  mkdirSync(cwd, { recursive: true })
  const body = {
    project: { name: "p" },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
    versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
    schema: { path: "./schema/index.ts" },
    ...extra,
  }
  writeFileSync(join(cwd, "supatype.config.ts"), `export default ${JSON.stringify(body)}\n`, "utf8")
  return cwd
}

describe("serviceRoleRoutesFor", () => {
  it("reads the declared list", () => {
    const cwd = projectWith({ functions: { serviceRole: ["send-email"] } })
    expect(serviceRoleRoutesFor(cwd)).toEqual(["send-email"])
  })

  it("is an empty list when a project declares none", () => {
    // Distinct from the case below: this project *has* said something, and it said nobody. The platform
    // stores that as a real revocation.
    expect(serviceRoleRoutesFor(projectWith({}))).toEqual([])
  })

  it("is undefined when the config cannot be read at all", () => {
    // Not []: the platform replaces its stored list wholesale whenever the field is present, so an
    // unreadable config sending [] would revoke every grant the project has.
    expect(serviceRoleRoutesFor(mkdtempSync(join(tmpdir(), "supatype-svcrole-none-")))).toBeUndefined()
  })

  it("sends what the project declared, hook entries included", () => {
    // Filtering hook routes out is the platform's job, not this one's: a hook is granted the key by the
    // worker anyway, and dropping the entry here would hide a mistake in the config rather than making
    // it harmless. Sorted, so an unchanged config produces an unchanged request.
    const cwd = projectWith({ functions: { serviceRole: ["send-email", "hooks/moderate-post"] } })
    expect(serviceRoleRoutesFor(cwd)).toEqual(["hooks/moderate-post", "send-email"])
  })
})
