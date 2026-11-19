import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { collectSiteFiles, deploySite } from "../src/site-deploy.js"
import { mockSite, sendJson, type MockSite } from "./support/site-server.js"
import { tempProject } from "./support/command-run.js"

/**
 * L1 of Cloud static hosting: the create call carries each file's NFC path, size and sha256, and the
 * app's `spa` flag, so the server can say which files it already holds.
 */
let project: { dir: string; remove: () => void }
let site: MockSite | undefined

beforeEach(() => {
  project = tempProject("site-deploy-manifest")
})

afterEach(async () => {
  await site?.close()
  site = undefined
  project.remove()
})

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

function write(rel: string, text: string): void {
  const file = join(project.dir, rel)
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, text)
}

describe("collectSiteFiles", () => {
  it("lists every file with its size, sha256 and a sorted POSIX path", () => {
    write("index.html", "<html></html>")
    write("assets/app.js", "console.log(1)")
    const files = collectSiteFiles(project.dir)
    expect(files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }))).toEqual([
      { path: "assets/app.js", size: 14, sha256: sha256("console.log(1)") },
      { path: "index.html", size: 13, sha256: sha256("<html></html>") },
    ])
  })

  it("normalises a decomposed path to NFC, and still reads the file by its real name", () => {
    const decomposed = "café.html"
    write(decomposed, "<p>x</p>")
    const [file] = collectSiteFiles(project.dir)
    expect(file?.path).toBe("café.html")
    expect(file?.path).not.toBe(decomposed)
    expect(file?.sha256).toBe(sha256("<p>x</p>"))
  })
})

describe("deploySite create call", () => {
  it("sends preview, spa and the manifest, with the org and environment headers", async () => {
    write("index.html", "<html></html>")
    site = await mockSite((req, res) => {
      if (req.method === "POST" && req.url.endsWith("/deployments")) {
        sendJson(res, 201, { data: { deploymentId: "d1", version: "v1", uploadUrl: `${site?.base ?? ""}/blobs`, missing: [], limits: {} } })
        return
      }
      sendJson(res, 200, { data: { version: "v1", status: "live", url: "https://demo.example.test" } })
    })
    await deploySite(site.target, project.dir, { spa: true, preview: false })
    const create = site.seen[0]
    expect(create?.method).toBe("POST")
    expect(create?.url).toBe("/api/v1/projects/demo/deployments")
    expect(create?.headers["x-org-id"]).toBe("org-1")
    expect(create?.headers["x-supatype-environment"]).toBe("production")
    expect(JSON.parse(create?.body.toString() ?? "{}")).toEqual({
      preview: false,
      spa: true,
      files: [{ path: "index.html", size: 13, sha256: sha256("<html></html>") }],
    })
  })
})
