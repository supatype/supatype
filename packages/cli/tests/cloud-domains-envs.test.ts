import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

type Call = { path: string; method: string; body: unknown }
let calls: Call[] = []
let respond: (call: Call) => unknown = () => []

vi.mock("../src/target-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/target-client.js")>()
  return {
    ...actual,
    targetFetch: async (_base: string, _prefix: string, opts: { path: string; method?: string; body?: unknown }) => {
      const call = { path: opts.path, method: opts.method ?? "GET", body: opts.body }
      calls.push(call)
      return respond(call)
    },
  }
})

import { registerCloud } from "../src/commands/cloud.js"

/**
 * Two Cloud commands that disagreed with the Cloud API.
 *
 * `domains verify` and `domains remove` take the domain's id, which is what the API's routes are keyed
 * by, and nothing printed one: `list` showed the name, status and CNAME, and `add` told you to verify
 * by name. `envs create` sent any name it did not recognise as `staging`, so `envs create qa` made a
 * staging environment and said it had made "staging".
 */
let project: { dir: string; remove: () => void }

const DOMAIN = {
  id: "5f1c2a7e-0d7b-4c3e-9a51-2f0e7c1d9b44",
  domain: "app.example.com",
  status: "pending_verification",
  cnameTarget: "acme.cname.supatype.app",
  sslExpiresAt: null,
}

function linkToCloud(dir: string): void {
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  const link = {
    version: 1,
    kind: "cloud",
    projectRef: "acme",
    defaultEnvironment: "production",
    token: "pat",
    cloudApiUrl: "https://api.example.test",
    environments: { production: { name: "production", apiUrl: "https://api.example.test", linkedAt: "2026-01-01T00:00:00Z" } },
  }
  writeFileSync(join(dir, ".supatype", "link.json"), JSON.stringify(link))
}

beforeEach(() => {
  project = tempProject("cloud-cmds")
  linkToCloud(project.dir)
  calls = []
  respond = (call) => (call.method === "GET" ? [] : {})
})

afterEach(() => project.remove())

describe("domains", () => {
  it("list prints the id that verify and remove take", async () => {
    respond = () => [DOMAIN]
    const run = await runCommand(registerCloud, ["domains", "list"], project.dir)
    expect(run.output).toContain(DOMAIN.id)
  })

  it("add tells you to verify by the id the API returned", async () => {
    respond = () => ({ ...DOMAIN, instructions: "Add a CNAME record" })
    const run = await runCommand(registerCloud, ["domains", "add", DOMAIN.domain], project.dir)
    expect(run.output).toContain(`supatype domains verify ${DOMAIN.id}`)
    expect(run.output).not.toContain(`supatype domains verify ${DOMAIN.domain}`)
  })
})

describe("envs create", () => {
  it("refuses a name Cloud does not create, listing the ones it does", async () => {
    const run = await runCommand(registerCloud, ["envs", "create", "qa"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(run.output).toMatch(/"qa".*staging.*preview/s)
    expect(calls.filter((call) => call.method === "POST")).toEqual([])
  })

  it("sends a known name as it is", async () => {
    respond = (call) => (call.method === "GET" ? [{ name: "preview", apiUrl: "https://preview.example.test" }] : {})
    const run = await runCommand(registerCloud, ["envs", "create", "preview"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ name: "preview" })
  })
})
