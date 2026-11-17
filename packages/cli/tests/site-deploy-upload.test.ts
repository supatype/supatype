import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { deploySite } from "../src/site-deploy.js"
import { mockSite, sendJson, type MockSite, type SeenRequest } from "./support/site-server.js"
import { tempProject } from "./support/command-run.js"

/**
 * L2 of Cloud static hosting: only the hashes the server lists as missing are uploaded, each to
 * `<uploadUrl>/<sha256>`, six at a time, with every status checked and a 5xx retried three times.
 */
let project: { dir: string; remove: () => void }
let site: MockSite | undefined

beforeEach(() => {
  project = tempProject("site-deploy-upload")
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

const isCreate = (req: SeenRequest): boolean => req.method === "POST" && req.url.endsWith("/deployments")
const blobsOf = (s: MockSite): SeenRequest[] => s.seen.filter((r) => r.method === "PUT")
const BLOBS = "/api/v1/projects/demo/deployments/d1/blobs"

/** A control plane that says `missing` is missing, and answers each blob PUT with `blob`. */
async function server(missing: string[], blob: (req: SeenRequest, res: import("node:http").ServerResponse) => void): Promise<MockSite> {
  const made: MockSite = await mockSite((req, res) => {
    if (isCreate(req)) {
      sendJson(res, 201, { data: { deploymentId: "d1", version: "v1", uploadUrl: `${made.base}${BLOBS}`, missing, limits: {} } })
    } else if (req.method === "PUT") {
      blob(req, res)
    } else {
      sendJson(res, 200, { data: { version: "v1", status: "live", url: "https://demo.example.test" } })
    }
  })
  site = made
  return made
}

const created = (_req: SeenRequest, res: import("node:http").ServerResponse): void => sendJson(res, 201, {})

const FAST = { spa: false, preview: false, retryDelayMs: 0 }

describe("blob uploads", () => {
  it("uploads only the missing hashes, to the hash url, with credentials and the file's own bytes", async () => {
    write("index.html", "<html>a</html>")
    write("app.js", "console.log(1)")
    const s = await server([sha256("console.log(1)")], created)
    await deploySite(s.target, project.dir, FAST)
    const puts = blobsOf(s)
    expect(puts.map((p) => p.url)).toEqual([`${BLOBS}/${sha256("console.log(1)")}`])
    expect(puts[0]?.body.toString()).toBe("console.log(1)")
    expect(puts[0]?.headers["authorization"]).toBe("Bearer tok")
    expect(puts[0]?.headers["x-org-id"]).toBe("org-1")
    expect(puts[0]?.headers["x-supatype-environment"]).toBe("production")
    expect(puts[0]?.headers["content-length"]).toBe("14")
  })

  it("uploads nothing when the server holds every file", async () => {
    write("index.html", "<html>a</html>")
    const s = await server([], created)
    await deploySite(s.target, project.dir, FAST)
    expect(blobsOf(s)).toEqual([])
  })

  it("uploads identical content once", async () => {
    write("a.html", "same")
    write("b.html", "same")
    const s = await server([sha256("same")], created)
    await deploySite(s.target, project.dir, FAST)
    expect(blobsOf(s)).toHaveLength(1)
  })

  it("has at most six uploads in flight", async () => {
    const texts = Array.from({ length: 14 }, (_, i) => `file ${i}`)
    texts.forEach((t, i) => write(`f${i}.html`, t))
    let inFlight = 0
    let peak = 0
    const s = await server(texts.map(sha256), (_req, res) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      setTimeout(() => {
        inFlight -= 1
        sendJson(res, 201, {})
      }, 40)
    })
    await deploySite(s.target, project.dir, FAST)
    expect(blobsOf(s)).toHaveLength(14)
    expect(peak).toBe(6)
  })

  it("retries a 5xx up to three times, then succeeds", async () => {
    write("index.html", "<html>a</html>")
    let attempts = 0
    const s = await server([sha256("<html>a</html>")], (_req, res) => {
      attempts += 1
      if (attempts <= 3) sendJson(res, 503, { error: "busy" })
      else sendJson(res, 201, {})
    })
    await deploySite(s.target, project.dir, FAST)
    expect(attempts).toBe(4)
  })

  it("gives up after the third retry and says which file and why", async () => {
    write("index.html", "<html>a</html>")
    const s = await server([sha256("<html>a</html>")], (_req, res) => sendJson(res, 502, { error: "storage down" }))
    await expect(deploySite(s.target, project.dir, FAST)).rejects.toThrow(/index\.html.*storage down/)
    expect(blobsOf(s)).toHaveLength(4)
  })

  it("does not retry a 4xx, and names the server's reason", async () => {
    write("index.html", "<html>a</html>")
    const s = await server([sha256("<html>a</html>")], (_req, res) => sendJson(res, 400, { code: "hash_mismatch", error: "content does not match its hash" }))
    await expect(deploySite(s.target, project.dir, FAST)).rejects.toThrow(/index\.html.*content does not match its hash/)
    expect(blobsOf(s)).toHaveLength(1)
  })

  it("does not finalize when an upload failed", async () => {
    write("index.html", "<html>a</html>")
    const s = await server([sha256("<html>a</html>")], (_req, res) => sendJson(res, 409, { error: "not uploading" }))
    await expect(deploySite(s.target, project.dir, FAST)).rejects.toThrow()
    expect(s.seen.some((r) => r.url.endsWith("/finalize"))).toBe(false)
  })

  it("refuses a missing hash that no local file has", async () => {
    write("index.html", "<html>a</html>")
    const s = await server([sha256("nothing like this")], created)
    await expect(deploySite(s.target, project.dir, FAST)).rejects.toThrow(/asked for a file the build does not have/)
  })
})
