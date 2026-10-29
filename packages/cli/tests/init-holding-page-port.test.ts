import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

/**
 * The page `init` scaffolds told people to open http://localhost:18473/ whatever gateway port the
 * project was given, while the next steps `init` printed named the project's own port. 18473 is
 * the first port tried, so any second project on a machine pointed its page at the first one.
 */
const dirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function holdingPage(opts: Parameters<typeof scaffold>[1]): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-holding-"))
  dirs.push(dir)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  scaffold(dir, opts)
  return readFileSync(join(dir, "public", "index.html"), "utf8")
}

describe("the scaffolded holding page", () => {
  const staticApp = { mode: "static", staticDir: "./public" } as const

  it("names the project's own gateway port", () => {
    const page = holdingPage({ ...defaultScaffoldOptions("acme"), app: staticApp, kongPort: 18490 })
    expect(page).toContain("http://localhost:18490/")
    expect(page).not.toContain("18473")
  })

  it("names the API server's port for a native project", () => {
    const page = holdingPage({ ...defaultScaffoldOptions("acme"), app: staticApp, provider: "native" })
    expect(page).toContain("http://localhost:54321/")
  })
})
