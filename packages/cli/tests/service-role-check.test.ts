import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { checkServiceRoleRoutes, serviceRoleProblemLines } from "../src/service-role-check.js"
import { fatalError } from "../src/ui/fatal.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

function config(serviceRole?: string[]): SupatypeProjectConfig {
  return {
    project: { name: "p" },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
    versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
    ...(serviceRole !== undefined && { functions: { serviceRole } }),
  } as SupatypeProjectConfig
}

/** A project whose functions/ holds the named directories, each with an index.ts. */
function projectWith(names: string[], bareFiles: string[] = []): string {
  const cwd = mkdtempSync(join(tmpdir(), "supatype-svcrole-check-"))
  const dir = join(cwd, "functions")
  mkdirSync(dir, { recursive: true })
  for (const name of names) {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, "index.ts"), "export default () => new Response()\n", "utf8")
  }
  for (const file of bareFiles) {
    writeFileSync(join(dir, `${file}.ts`), "export default () => new Response()\n", "utf8")
  }
  return cwd
}

describe("checkServiceRoleRoutes", () => {
  it("says nothing when a project grants nothing", () => {
    const problems = checkServiceRoleRoutes(config(), projectWith([]))
    expect(problems.errors).toEqual([])
    expect(problems.warnings).toEqual([])
  })

  it("accepts a name that matches a function directory", () => {
    const problems = checkServiceRoleRoutes(config(["send-email"]), projectWith(["send-email"]))
    expect(problems.errors).toEqual([])
  })

  it("accepts a bare <name>.ts function, which the worker also serves", () => {
    const problems = checkServiceRoleRoutes(config(["audit"]), projectWith([], ["audit"]))
    expect(problems.errors).toEqual([])
  })

  it("reports a typo, which would otherwise grant nothing in silence", () => {
    // The failure this exists for: the grant fails closed, so the function reads no key at runtime in a
    // deploy that reported success.
    const problems = checkServiceRoleRoutes(config(["send-emial"]), projectWith(["send-email"]))
    expect(problems.errors).toHaveLength(1)
    expect(problems.errors[0]).toContain("send-emial")
    // Structural too, so `doctor` can mark the entry without parsing the printed line back apart.
    expect(problems.missing).toEqual(["send-emial"])
  })

  it("reports a name whose function was renamed away", () => {
    const problems = checkServiceRoleRoutes(config(["send-email"]), projectWith(["mailer"]))
    expect(problems.errors).toHaveLength(1)
  })

  it("warns rather than fails on a hook entry", () => {
    // It was the documented form once, and the worker grants hooks whatever the list says, so it is
    // harmless, and worth saying because a reader would assume the line is what grants.
    const problems = checkServiceRoleRoutes(config(["hooks/moderate-post"]), projectWith([]))
    expect(problems.errors).toEqual([])
    expect(problems.warnings).toHaveLength(1)
    expect(problems.warnings[0]).toContain("not needed")
  })

  it("ignores an index-less directory, matching how the worker discovers routes", () => {
    const cwd = projectWith([])
    mkdirSync(join(cwd, "functions", "half-written"), { recursive: true })
    const problems = checkServiceRoleRoutes(config(["half-written"]), cwd)
    expect(problems.errors).toHaveLength(1)
  })
})

describe("serviceRoleProblemLines", () => {
  it("is empty when nothing is wrong", () => {
    expect(serviceRoleProblemLines({ errors: [], missing: [], warnings: [], available: ["a"] })).toEqual([])
  })

  it("lists what could have been named instead", () => {
    const lines = serviceRoleProblemLines({
      errors: ['  "x": no functions/x/index.ts'],
      missing: ["x"],
      warnings: [],
      available: ["audit", "send-email"],
    })
    expect(lines.join("\n")).toContain("Functions found: audit, send-email")
  })

  // Local test round 3: the refusal printed lines of only two spaces: fatalError indented the blank
  // entries here, though it already spaces its hints apart. It now skips a blank hint.
  it("prints through fatalError with no line of only spaces", () => {
    const printed: string[] = []
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("exited")
    })
    const lines = serviceRoleProblemLines({ errors: ['  "x": nope'], missing: ["x"], warnings: [], available: [] })
    expect(() => fatalError("functions.serviceRole names a function that does not exist.", [...lines, ""])).toThrow("exited")
    vi.restoreAllMocks()
    expect(printed.some((line) => line !== "" && line.trim() === "")).toBe(false)
    expect(printed.join("\n")).toContain("No functions found")
  })

  it("says so when there are no functions at all", () => {
    const lines = serviceRoleProblemLines({
      errors: ['  "x": nope'],
      missing: ["x"],
      warnings: [],
      available: [],
    })
    expect(lines.join("\n")).toContain("No functions found")
  })
})
