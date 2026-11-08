import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * Issue 79: on a dev stack, `status` listed the functions the control plane answered and nothing
 * else, where its help says "Show linked target status or local stack services".
 */
const target = vi.hoisted(() => ({ mode: "local" as "local" | "cloud" }))

vi.mock("../src/link.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/link.js")>()),
  loadProjectLink: () => null,
  loadLocalEnvironment: () => ({ apiUrl: "http://localhost:18640", databaseUrl: "postgresql://supatype_admin:hunter2@db:5432/acme" }),
}))
vi.mock("../src/resolve-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/resolve-target.js")>()),
  resolveTarget: () => ({ mode: target.mode, environment: "local", projectRef: "acme", apiBaseUrl: "http://localhost:18640", apiPrefix: "/platform/v1" }),
  targetStatus: async () => ({ functions: ["hello"] }),
}))
vi.mock("../src/compose-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-services.js")>()),
  composeContext: () => ({ projectName: "supatype-acme", config }),
  composeServices: async () => [{ service: "server", container: "supatype-acme-server-1", state: "running", ports: "" }],
}))

const config = vi.hoisted((): import("../src/project-config.js").SupatypeProjectConfig => ({
  project: { name: "acme" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
}))

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { registerStatus } from "../src/commands/status.js"

let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("status-local")
})

afterEach(() => {
  project.remove()
})

describe("status", () => {
  it("lists a local stack's services after its functions", async () => {
    target.mode = "local"
    const run = await runCommand(registerStatus, ["status"], project.dir)
    expect(run.output).toContain("hello")
    expect(run.output).toContain("server")
    expect(run.output).toContain("1/1 services running")
  })

  // Issue 80: it printed the URL the db container is reached by inside the stack, password and all.
  it("prints the database as this machine reaches it, without its password", async () => {
    target.mode = "local"
    writeFileSync(join(project.dir, ".env"), "DATABASE_URL=postgresql://supatype_admin:hunter2@127.0.0.1:54329/acme\n")
    const run = await runCommand(registerStatus, ["status"], project.dir)
    expect(run.output).not.toContain("hunter2")
    expect(run.output).toContain("Database:   postgresql://supatype_admin:***@127.0.0.1:54329/acme")
  })

  it("does not list this machine's services for a remote target", async () => {
    target.mode = "cloud"
    const run = await runCommand(registerStatus, ["status"], project.dir)
    expect(run.output).not.toContain("services running")
  })
})
