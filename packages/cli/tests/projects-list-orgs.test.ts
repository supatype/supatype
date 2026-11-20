import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * `supatype projects list` before `link` failed with "HTTP 400 Bad Request: X-Org-Id header is
 * required": the control plane scopes projects to an organisation, and with no linked project the
 * CLI had none to send. The docs say it works any time after login. The CLI asks GET /organisations:
 * one org is used, several are each listed, and `--org <slug>` picks one.
 */
interface Call {
  path: string
  orgId: string | undefined
}

const calls = vi.hoisted(() => ({ made: [] as { path: string; orgId: string | undefined }[] }))
const answers = vi.hoisted(() => ({
  orgs: [] as { id: string; name: string; slug: string }[],
  projects: {} as Record<string, unknown[]>,
}))

vi.mock("../src/cloud-credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cloud-credentials.js")>()),
  loadCloudCredentials: () => ({ version: 1, apiUrl: "http://api.lvh.me:18680", accessToken: "spt_stored", updatedAt: "" }),
}))
vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async (_base: string, _prefix: string, opts: { path: string; orgId?: string }) => {
    calls.made.push({ path: opts.path, orgId: opts.orgId })
    if (opts.path === "/organisations") return answers.orgs
    if (opts.orgId === undefined) throw new Error("HTTP 400 Bad Request: X-Org-Id header is required")
    return answers.projects[opts.orgId] ?? []
  },
}))

const { registerCloud } = await import("../src/commands/cloud.js")

const ACME = { id: "org-acme", name: "Acme", slug: "acme" }
const BETA = { id: "org-beta", name: "Beta Co", slug: "beta" }

function project(slug: string): unknown {
  return { name: `${slug} app`, slug, tier: "free", region: "eu-fsn", status: "active" }
}

let dir: { dir: string; remove: () => void }

beforeEach(() => {
  dir = tempProject("projects-list-orgs")
  calls.made = []
  answers.orgs = [ACME]
  answers.projects = { "org-acme": [project("acme-web")], "org-beta": [project("beta-api")] }
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  dir.remove()
})

function list(...extra: string[]): ReturnType<typeof runCommand> {
  return runCommand(registerCloud, ["projects", "list", ...extra], dir.dir)
}

const projectCalls = (): Call[] => calls.made.filter((call) => call.path === "/projects")

describe("projects list with no linked project", () => {
  it("uses the account's only organisation", async () => {
    const run = await list()
    expect(run.exitCode).toBeUndefined()
    expect(projectCalls()).toEqual([{ path: "/projects", orgId: "org-acme" }])
    expect(run.output).toContain("acme-web")
  })

  it("lists the projects of every organisation when there are several", async () => {
    answers.orgs = [ACME, BETA]
    const run = await list()
    expect(projectCalls().map((call) => call.orgId)).toEqual(["org-acme", "org-beta"])
    expect(run.output).toContain("acme-web")
    expect(run.output).toContain("beta-api")
    expect(run.output).toContain("Beta Co")
  })

  it("takes --org <slug> to list one organisation", async () => {
    answers.orgs = [ACME, BETA]
    const run = await list("--org", "beta")
    expect(projectCalls()).toEqual([{ path: "/projects", orgId: "org-beta" }])
    expect(run.output).toContain("beta-api")
    expect(run.output).not.toContain("acme-web")
  })

  it("refuses an --org the account is not in, naming the ones it is", async () => {
    answers.orgs = [ACME, BETA]
    const run = await list("--org", "nope")
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("nope")
    expect(run.output).toContain("acme")
    expect(run.output).toContain("beta")
    expect(projectCalls()).toEqual([])
  })

  it("says so when the account has no organisation", async () => {
    answers.orgs = []
    const run = await list()
    expect(run.output).toMatch(/not in any organisation/i)
    expect(projectCalls()).toEqual([])
  })
})
