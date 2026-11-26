import { Command } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NoStackRunning } from "../src/host-database.js"

/**
 * FF-27: `db connection-string` on a linked Cloud project answered "The local stack isn't running":
 * it resolved the local database before it looked at the link, though Cloud's string comes from the
 * control plane and the local stack has nothing to do with it.
 */

const printed: string[] = []

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => ({ project: { name: "app" } }),
}))
vi.mock("../src/link.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/link.js")>()),
  loadProjectLink: () => ({ kind: "cloud", projectRef: "app" }),
}))
vi.mock("../src/host-database.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/host-database.js")>()),
  resolveHostDatabaseUrl: () => {
    throw new NoStackRunning()
  },
}))
vi.mock("../src/resolve-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/resolve-target.js")>()),
  resolveTarget: () => ({ mode: "cloud", projectRef: "app", apiBaseUrl: "https://api.example", apiPrefix: "/api/v1", token: "t", link: null }),
}))
vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async () => [{ name: "production", databaseUrl: "postgres://cloud.example:5432/app" }],
}))
vi.mock("../src/ui/messages.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, plain: (line = "") => printed.push(line), error: (line: string) => printed.push(`error: ${line}`) }
})

const { registerDb } = await import("../src/commands/db.js")

afterEach(() => {
  printed.length = 0
  process.exitCode = undefined
})

describe("db connection-string on a linked Cloud project", () => {
  it("prints the control plane's string with no local stack running", async () => {
    const program = new Command().exitOverride()
    registerDb(program)
    await program.parseAsync(["node", "supatype", "db", "connection-string"])
    expect(printed[0]).toBe("postgres://cloud.example:5432/app")
  })
})
