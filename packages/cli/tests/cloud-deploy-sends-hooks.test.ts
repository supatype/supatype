import { afterEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"

const steps = vi.hoisted(() => [] as string[])
const target = vi.hoisted(() => ({ mode: "cloud", environment: "production", projectRef: "demo", apiBaseUrl: "https://api.example.test", apiPrefix: "/api/v1", token: "t", link: null }) as const)

vi.mock("../src/resolve-target.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/resolve-target.js")>()
  return {
    ...actual,
    resolveTarget: () => target,
    schemaPgSchema: () => "public",
    targetSchemaPush: async () => {
      steps.push("schema")
      return { message: "Migration applied." }
    },
  }
})
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>()
  return {
    ...actual,
    loadConfig: () => projectConfig({ api: { corsOrigins: ["https://app.example.com"] } }),
    loadSchemaAst: () => ({ models: [] }),
  }
})
vi.mock("../src/commands/push.js", () => ({
  runPostApplySteps: async () => {
    steps.push("post-apply")
    return false
  },
}))

const { pushSchemaToLinkedProject } = await import("../src/commands/cloud.js")

/**
 * `supatype deploy` to a Cloud project pushed the schema and stopped. Its hooks and field validators
 * were never sent, so a project only ever deployed ran without them, and a hook changed since the
 * last `supatype push` kept its old code. A deploy now sends what a push sends after the schema.
 */
afterEach(() => {
  steps.length = 0
  vi.restoreAllMocks()
})

describe("a deploy to a linked Cloud project", () => {
  it("runs push's steps after the schema: hooks, allowed origins, platform settings", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    await pushSchemaToLinkedProject(process.cwd(), { force: true, env: "production" })
    expect(steps).toEqual(["schema", "post-apply"])
  })
})
