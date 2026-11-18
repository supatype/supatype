import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { registerCloud } from "../src/commands/cloud.js"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * New-user test on Supatype Cloud: after `supatype login --api-url http://api.lvh.me:18680`,
 * `supatype link --project demo` failed with "fetch failed". `link --api-url` defaulted to
 * https://api.supatype.com, so the Cloud the user had signed in to was never asked. A link uses the
 * flag, then SUPATYPE_API_URL, then the URL the login stored, then the default.
 */
const STORED = "http://api.lvh.me:18680"
const stored = vi.hoisted(() => ({ apiUrl: undefined as string | undefined }))

vi.mock("../src/cloud-credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cloud-credentials.js")>()),
  loadCloudCredentials: () =>
    stored.apiUrl === undefined ? null : { version: 1, apiUrl: stored.apiUrl, accessToken: "spt_stored", updatedAt: "" },
}))

let project: { dir: string; remove: () => void }
let asked: string[] = []

beforeEach(() => {
  project = tempProject("link-cloud-api-url")
  scaffold(project.dir, defaultScaffoldOptions("lk"))
  stored.apiUrl = STORED
  asked = []
  vi.stubEnv("SUPATYPE_API_URL", "")
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "")
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(String(url))
    return Response.json({ data: { slug: "demo", orgId: "org-1" } })
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  project.remove()
})

async function link(...extra: string[]): Promise<void> {
  const run = await runCommand(registerCloud, ["link", "--project", "demo", ...extra], project.dir)
  expect(run.exitCode).toBeUndefined()
}

describe("supatype link --project, which Cloud it asks", () => {
  it("asks the Cloud the login stored when nothing else names one", async () => {
    await link()
    expect(asked[0]).toBe(`${STORED}/api/v1/projects/demo`)
  })

  it("asks the --api-url flag before anything else", async () => {
    vi.stubEnv("SUPATYPE_API_URL", "http://env.example.test")
    await link("--api-url", "http://flag.example.test/")
    expect(asked[0]).toBe("http://flag.example.test/api/v1/projects/demo")
  })

  it("asks SUPATYPE_API_URL before the stored login", async () => {
    vi.stubEnv("SUPATYPE_API_URL", "http://env.example.test")
    await link()
    expect(asked[0]).toBe("http://env.example.test/api/v1/projects/demo")
  })

  it("asks the default Cloud when there is no flag, variable or login URL", async () => {
    stored.apiUrl = undefined
    vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "spt_from_env")
    await link()
    expect(asked[0]).toBe("https://api.supatype.com/api/v1/projects/demo")
  })
})
