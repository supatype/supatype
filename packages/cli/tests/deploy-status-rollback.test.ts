import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"
import { mockSite, sendJson, type MockSite } from "./support/site-server.js"
import { runCommand, tempProject } from "./support/command-run.js"

vi.mock("../src/config.js", async (importOriginal) => ({ ...(await importOriginal()), loadConfig: () => projectConfig() }))

const { registerDeploy } = await import("../src/commands/deploy.js")

/**
 * `deploy status` and `deploy rollback` against Cloud: the site's address, the live version and
 * when it went live, the size against the plan, and the over-plan good-will date.
 */
let project: { dir: string; remove: () => void }
let site: MockSite | undefined

beforeEach(() => {
  project = tempProject("deploy-status")
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
})

afterEach(async () => {
  await site?.close()
  site = undefined
  project.remove()
})

function linkTo(apiUrl: string): void {
  const link = {
    version: 1,
    kind: "cloud",
    projectRef: "demo",
    defaultEnvironment: "production",
    token: "pat",
    cloudApiUrl: apiUrl,
    environments: { production: { name: "production", apiUrl, linkedAt: "2026-01-01T00:00:00Z" } },
  }
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify(link))
}

async function serve(status: number, data: unknown): Promise<MockSite> {
  site = await mockSite((_req, res) => sendJson(res, status, { data }))
  linkTo(site.base)
  return site
}

const MB = 1024 * 1024
const live = {
  version: "v7-abcd",
  status: "live",
  timestamp: "2026-11-16T10:30:00.000Z",
  size: 80 * MB,
  url: "https://demo.tenant.example.test",
  planBytes: 50 * MB,
}

describe("deploy status", () => {
  it("prints the address, the version, when it went live, and the size against the plan", async () => {
    await serve(200, { ...live, overSince: null, goodwillEndsAt: null })
    const run = await runCommand(registerDeploy, ["deploy", "status"], project.dir)
    expect(run.output).toMatch(/https:\/\/demo\.tenant\.example\.test/)
    expect(run.output).toMatch(/v7-abcd/)
    expect(run.output).toMatch(/2026-11-16T10:30:00/)
    expect(run.output).toMatch(/80 MB of 50 MB/)
    expect(run.output).not.toMatch(/overage/)
  })

  it("when over plan, says the good-will date with the upgrade wording", async () => {
    await serve(200, { ...live, overSince: "2026-11-10T09:00:00.000Z", goodwillEndsAt: "2026-11-24T09:00:00.000Z" })
    const run = await runCommand(registerDeploy, ["deploy", "status"], project.dir)
    expect(run.output).toMatch(/Upgrade your plan before 2026-11-24 to avoid overage charges/)
  })

  it("under plan, shows the size against the plan and no warning", async () => {
    await serve(200, { ...live, size: 10 * MB })
    const run = await runCommand(registerDeploy, ["deploy", "status"], project.dir)
    expect(run.output).toMatch(/10 MB of 50 MB/)
    expect(run.output).not.toMatch(/overage/)
  })

  it("shows a tiny site in bytes, not rounded up to 1 MB", async () => {
    await serve(200, { ...live, size: 985 })
    const run = await runCommand(registerDeploy, ["deploy", "status"], project.dir)
    expect(run.output).toMatch(/Size: 985 B of 50 MB plan/)
    expect(run.output).not.toMatch(/Size: 1 MB/)
  })

  it("shows a small site in KB with one decimal at most", async () => {
    await serve(200, { ...live, size: 1536 })
    const run = await runCommand(registerDeploy, ["deploy", "status"], project.dir)
    expect(run.output).toMatch(/Size: 1\.5 KB of 50 MB plan/)
  })

  it("without a plan, shows the same units", async () => {
    await serve(200, { ...live, size: 2 * MB + MB / 2, planBytes: null })
    const run = await runCommand(registerDeploy, ["deploy", "status"], project.dir)
    expect(run.output).toMatch(/Size: 2\.5 MB$/m)
  })
})

describe("deploy rollback", () => {
  it("prints the live address and the version it rolled back to", async () => {
    await serve(200, { version: "v6-ffff", message: "Rolled back to deployment v6-ffff.", url: "https://demo.tenant.example.test" })
    const run = await runCommand(registerDeploy, ["deploy", "rollback"], project.dir)
    expect(run.output).toMatch(/v6-ffff/)
    expect(run.output).toMatch(/https:\/\/demo\.tenant\.example\.test/)
  })
})
