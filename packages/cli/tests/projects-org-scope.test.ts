import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * `projects create`, `pause` and `resume` before a link: create needs an organisation (the control
 * plane creates the project in the one `X-Org-Id` names), and none was sent. They resolve it as
 * `projects list` does: the account's only organisation, or `--org <slug>`; with several and no
 * `--org`, create refuses and says to pass one. Pause and resume work on a slug and send the
 * organisation only when it is known.
 */
const calls = vi.hoisted(() => ({ made: [] as { method: string; path: string; orgId: string | undefined }[] }))
const answers = vi.hoisted(() => ({ orgs: [] as { id: string; name: string; slug: string }[] }))

vi.mock("../src/cloud-credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cloud-credentials.js")>()),
  loadCloudCredentials: () => ({ version: 1, apiUrl: "http://api.lvh.me:18680", accessToken: "spt_stored", updatedAt: "" }),
}))
vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async (_base: string, _prefix: string, opts: { method: string; path: string; orgId?: string }) => {
    calls.made.push({ method: opts.method, path: opts.path, orgId: opts.orgId })
    if (opts.path === "/organisations") return answers.orgs
    if (opts.method === "POST" && opts.path === "/projects") {
      if (opts.orgId === undefined) throw new Error("HTTP 400 Bad Request: X-Org-Id header is required")
      return { slug: "demo", name: "demo", status: "provisioning" }
    }
    return {}
  },
}))

const { registerCloud } = await import("../src/commands/cloud.js")

const ACME = { id: "org-acme", name: "Acme", slug: "acme" }
const BETA = { id: "org-beta", name: "Beta Co", slug: "beta" }

let dir: { dir: string; remove: () => void }

beforeEach(() => {
  dir = tempProject("projects-org-scope")
  calls.made = []
  answers.orgs = [ACME]
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  dir.remove()
})

const run = (...argv: string[]): ReturnType<typeof runCommand> => runCommand(registerCloud, argv, dir.dir)
const sent = (method: string, path: string) => calls.made.filter((c) => c.method === method && c.path === path)

describe("projects create with no linked project", () => {
  it("creates in the account's only organisation", async () => {
    const result = await run("projects", "create", "demo")
    expect(result.exitCode).toBeUndefined()
    expect(sent("POST", "/projects")).toEqual([{ method: "POST", path: "/projects", orgId: "org-acme" }])
  })

  it("creates in the organisation --org names", async () => {
    answers.orgs = [ACME, BETA]
    await run("projects", "create", "demo", "--org", "beta")
    expect(sent("POST", "/projects")[0]?.orgId).toBe("org-beta")
  })

  it("refuses with several organisations and no --org, naming them", async () => {
    answers.orgs = [ACME, BETA]
    const result = await run("projects", "create", "demo")
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("--org")
    expect(result.output).toContain("acme")
    expect(result.output).toContain("beta")
    expect(sent("POST", "/projects")).toEqual([])
  })
})

describe("projects pause and resume with no linked project", () => {
  it("send the only organisation", async () => {
    await run("projects", "pause", "demo")
    await run("projects", "resume", "demo")
    expect(sent("POST", "/projects/demo/pause")[0]?.orgId).toBe("org-acme")
    expect(sent("POST", "/projects/demo/resume")[0]?.orgId).toBe("org-acme")
  })

  it("send the --org organisation", async () => {
    answers.orgs = [ACME, BETA]
    await run("projects", "pause", "demo", "--org", "beta")
    expect(sent("POST", "/projects/demo/pause")[0]?.orgId).toBe("org-beta")
  })

  it("still run with several organisations and no --org, since the slug names the project", async () => {
    answers.orgs = [ACME, BETA]
    const result = await run("projects", "resume", "demo")
    expect(result.exitCode).toBeUndefined()
    expect(sent("POST", "/projects/demo/resume")).toHaveLength(1)
  })
})
