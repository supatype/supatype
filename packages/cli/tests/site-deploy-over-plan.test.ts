import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deploySite } from "../src/site-deploy.js"
import { mockSite, sendJson, type MockSite } from "./support/site-server.js"
import { tempProject } from "./support/command-run.js"

/**
 * Plan size is a soft limit: a site over it still goes live, and the create answer carries a
 * warning that the CLI prints after the deploy, with the sizes and the date the good-will ends.
 */
let project: { dir: string; remove: () => void }
let site: MockSite | undefined
let printed: string[]

beforeEach(() => {
  project = tempProject("site-deploy-over-plan")
  mkdirSync(project.dir, { recursive: true })
  writeFileSync(join(project.dir, "index.html"), "<html></html>")
  printed = []
  const capture = (...args: unknown[]): void => void printed.push(args.map(String).join(" "))
  vi.spyOn(console, "log").mockImplementation(capture)
  vi.spyOn(console, "warn").mockImplementation(capture)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await site?.close()
  site = undefined
  project.remove()
})

const MB = 1024 * 1024
const FAST = { spa: true, preview: false, retryDelayMs: 0 }

async function deployWith(warnings: unknown): Promise<void> {
  const made: MockSite = await mockSite((req, res) => {
    if (req.url.endsWith("/finalize")) {
      sendJson(res, 200, { data: { version: "v1", status: "live", url: "https://demo.tenant.example.test" } })
      return
    }
    const created = { deploymentId: "d1", version: "v1", uploadUrl: `${made.base}/blobs`, missing: [], limits: {} }
    sendJson(res, 201, { data: warnings === undefined ? created : { ...created, warnings } })
  })
  site = made
  await deploySite(made.target, project.dir, FAST)
}

const overPlan = {
  code: "site_over_plan",
  message: "the site is over the plan",
  planBytes: 50 * MB,
  siteBytes: 80 * MB,
  overSince: "2026-11-10T09:00:00.000Z",
  goodwillEndsAt: "2026-11-24T09:00:00.000Z",
}

describe("site_over_plan warning", () => {
  it("prints the site size, the plan size and the date to upgrade before", async () => {
    await deployWith([overPlan])
    const out = printed.join("\n")
    expect(out).toMatch(/80 MB/)
    expect(out).toMatch(/50 MB/)
    expect(out).toMatch(/Upgrade your plan before 2026-11-24 to avoid overage charges/)
  })

  it("prints nothing about a plan when the answer has no warnings", async () => {
    await deployWith(undefined)
    expect(printed.join("\n")).not.toMatch(/plan|overage/i)
  })

  it("prints an unknown code's message as a plain warning", async () => {
    await deployWith([{ code: "something_new", message: "heads up from the server" }])
    const out = printed.join("\n")
    expect(out).toMatch(/heads up from the server/)
    expect(out).not.toMatch(/overage/)
  })
})
