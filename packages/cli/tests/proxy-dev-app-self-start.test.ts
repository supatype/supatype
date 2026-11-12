import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProcessOptions } from "../src/process-manager.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * 0.9.1 release test: init's "Local dev server" answer left at its default wrote `app.start: "dev"`
 * beside its own `"dev": "supatype dev"`, so `supatype dev` ran itself as the app, and that copy
 * exited 1 and was restarted for ever. Dev refuses a script that runs `supatype dev`, and marks the
 * app it does start so a `supatype dev` reached some other way can tell where it is.
 */
const managers = vi.hoisted(() => ({ made: [] as { bin: string; args: string[]; opts: ProcessOptions }[] }))
vi.mock("../src/process-manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/process-manager.js")>()),
  ProcessManager: class {
    constructor(bin: string, args: string[], opts: ProcessOptions) {
      managers.made.push({ bin, args, opts })
    }
    start(): void {}
  },
}))
vi.mock("../src/dev-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev-session.js")>()),
  appendDevTaskLog: () => undefined,
}))

const { startProxyDevApp } = await import("../src/app/proxy-dev-app.js")

let dir = ""
let warnings: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-self-start-"))
  warnings = []
  vi.spyOn(console, "warn").mockImplementation((message: string) => void warnings.push(message))
})

afterEach(() => {
  vi.restoreAllMocks()
  managers.made = []
  rmSync(dir, { recursive: true, force: true })
})

function project(scripts: Record<string, string>, start: string): SupatypeProjectConfig {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme", scripts }))
  return {
    project: { name: "acme" },
    database: { provider: "native" },
    server: { mode: "dev" },
    versions: { engine: "latest", server: "latest", postgres: "latest", deno: "latest" },
    app: { mode: "proxy", upstream: "http://localhost:3000", start },
  }
}

describe("startProxyDevApp and a script that runs supatype dev", () => {
  it.each([
    ["supatype dev"],
    ["npx supatype dev --no-open"],
    ["npx @supatype/cli dev"],
    ["node ./node_modules/.bin/supatype dev"],
    ["tsc -b && supatype dev"],
  ])("does not start %j, and says how to fix it", (body) => {
    expect(startProxyDevApp(dir, project({ dev: body }, "dev"), dir)).toBeNull()
    expect(managers.made).toEqual([])
    expect(warnings.join("\n")).toMatch(/"dev" runs supatype dev.*app\.start/s)
  })

  it.each([["next dev"], ["vite"], ["supatype-docs dev"], ["supatype devices"]])("starts %j", (body) => {
    expect(startProxyDevApp(dir, project({ web: body }, "web"), dir)).not.toBeNull()
    expect(managers.made).toHaveLength(1)
  })

  it("marks the app it starts as dev's app", () => {
    startProxyDevApp(dir, project({ web: "next dev" }, "web"), dir)
    expect(managers.made[0]?.opts.env).toMatchObject({ SUPATYPE_DEV_APP: "1" })
  })
})
