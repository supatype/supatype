import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { validateBuildOutput } from "../src/app/framework.js"
import { registerDeploy } from "../src/commands/deploy.js"
import { deploySite } from "../src/site-deploy.js"
import { mockSite, sendJson, type MockSite } from "./support/site-server.js"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * L4 of Cloud static hosting: the server's own tier limits decide how big a site may be, and
 * previews, which Cloud does not offer yet, are refused before anything is built.
 */
let project: { dir: string; remove: () => void }
let site: MockSite | undefined

beforeEach(() => {
  project = tempProject("site-deploy-limits")
})

afterEach(async () => {
  await site?.close()
  site = undefined
  project.remove()
})

function linkTo(kind: "cloud" | "self-host", apiUrl: string): void {
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  const link = {
    version: 1,
    kind,
    projectRef: "demo",
    defaultEnvironment: "production",
    token: "pat",
    cloudApiUrl: apiUrl,
    environments: { production: { name: "production", apiUrl, linkedAt: "2026-01-01T00:00:00Z" } },
  }
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify(link))
}

describe("the server's limit decides", () => {
  it("validateBuildOutput applies no size limit when it is given none", () => {
    writeFileSync(join(project.dir, "index.html"), "<html></html>")
    writeFileSync(join(project.dir, "big.bin"), Buffer.alloc(2 * 1024 * 1024))
    expect(validateBuildOutput(project.dir, 1)).toMatch(/exceeds limit/)
    expect(validateBuildOutput(project.dir)).toBeNull()
  })

  it("a 413 from create stops the deploy before any upload, with the server's reason", async () => {
    writeFileSync(join(project.dir, "index.html"), "<html></html>")
    site = await mockSite((_req, res) => sendJson(res, 413, { code: "site_too_large", error: "the site is 80 MiB, over the 50 MiB limit for the free tier" }))
    await expect(deploySite(site.target, project.dir, { spa: true, preview: false, retryDelayMs: 0 })).rejects.toThrow(/413.*over the 50 MiB limit for the free tier/)
    expect(site.seen).toHaveLength(1)
  })
})

describe("deploy --preview against Cloud", () => {
  it("is refused before the config is read, anything is built or the server is called", async () => {
    site = await mockSite((_req, res) => sendJson(res, 500, {}))
    linkTo("cloud", site.base)
    const run = await runCommand(registerDeploy, ["deploy", "--preview", "--app-only"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(run.output).toMatch(/Previews are not available on Supatype Cloud yet/)
    expect(run.output).toMatch(/without --preview/)
    expect(site.seen).toEqual([])
  })
})
