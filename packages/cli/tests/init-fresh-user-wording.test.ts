import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defaultScaffoldOptions, initStepBlocks, scaffold } from "../src/commands/init.js"
import { NATIVE_SERVER_PORT } from "../src/project-config.js"

/**
 * Fresh-user test C11 and C12, what init writes and prints:
 * - the first admin is for Studio, at /studio/, not "/admin";
 * - a project that chose no app is not told how to serve a static frontend;
 * - a docker project's config does not carry `server.port`, which is the native server's
 *   port: its API is on the gateway port, so the field only misled.
 */
let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `dt-init-wording-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("init wording", () => {
  it("says the first admin is for Studio at /studio/", () => {
    scaffold(dir, { ...defaultScaffoldOptions("w-app"), adminEmail: "a@b.test", adminPassword: "longenough" })
    const env = readFileSync(join(dir, ".env"), "utf8")
    expect(env).not.toContain("/admin")
    expect(env).toContain("/studio/")
  })

  it("prints no static frontend steps when no app was chosen", () => {
    const result = { ...defaultScaffoldOptions("w-app"), packageManager: "npm" as const }
    const blocks = initStepBlocks({ name: "w-app", result, installed: true, keysGenerated: true, binariesReady: true })
    const printed = blocks.flatMap((block) => [block.title, ...block.steps, block.after ?? ""]).join("\n")
    expect(printed).not.toContain("Static frontend")
    expect(printed).not.toContain("app add --static")
  })
})

describe("init config server block", () => {
  it("leaves server.port out of a docker project's config", () => {
    scaffold(dir, defaultScaffoldOptions("d-app"))
    expect(readFileSync(join(dir, "supatype.config.ts"), "utf8")).not.toContain(`port: ${NATIVE_SERVER_PORT},`)
  })

  it("keeps it for a native project, whose server listens on it", () => {
    scaffold(dir, { ...defaultScaffoldOptions("n-app"), provider: "native" })
    expect(readFileSync(join(dir, "supatype.config.ts"), "utf8")).toContain(`port: ${NATIVE_SERVER_PORT},`)
  })
})
