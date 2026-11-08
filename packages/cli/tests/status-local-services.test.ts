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
  loadLocalEnvironment: () => ({ apiUrl: "http://localhost:18640" }),
}))
vi.mock("../src/resolve-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/resolve-target.js")>()),
  resolveTarget: () => ({ mode: target.mode, environment: "local", projectRef: "acme", apiBaseUrl: "http://localhost:18640", apiPrefix: "/platform/v1" }),
  targetStatus: async () => ({ functions: ["hello"] }),
}))
vi.mock("../src/compose-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-services.js")>()),
  composeContext: () => ({ projectName: "supatype-acme" }),
  composeServices: async () => [{ service: "server", container: "supatype-acme-server-1", state: "running", ports: "" }],
}))

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

  it("does not list this machine's services for a remote target", async () => {
    target.mode = "cloud"
    const run = await runCommand(registerStatus, ["status"], project.dir)
    expect(run.output).not.toContain("services running")
  })
})
