import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { deploySite } from "../src/site-deploy.js"
import { mockSite, sendJson, type MockSite, type SeenRequest } from "./support/site-server.js"
import { tempProject } from "./support/command-run.js"

/**
 * L3 of Cloud static hosting: finalize is checked. The site's url comes from its answer, a 502
 * `pointer_not_pushed` is retried (finalize is idempotent), and any other refusal stops the deploy.
 */
let project: { dir: string; remove: () => void }
let site: MockSite | undefined

beforeEach(() => {
  project = tempProject("site-deploy-finalize")
  mkdirSync(project.dir, { recursive: true })
  writeFileSync(join(project.dir, "index.html"), "<html></html>")
})

afterEach(async () => {
  await site?.close()
  site = undefined
  project.remove()
})

const isFinalize = (req: SeenRequest): boolean => req.url.endsWith("/finalize")
const finalizesOf = (s: MockSite): SeenRequest[] => s.seen.filter(isFinalize)
const FAST = { spa: true, preview: false, retryDelayMs: 0 }

/** A control plane with nothing to upload, whose finalize is answered by `finalize`. */
async function server(finalize: (attempt: number, res: import("node:http").ServerResponse) => void): Promise<MockSite> {
  let attempt = 0
  const made: MockSite = await mockSite((req, res) => {
    if (isFinalize(req)) {
      attempt += 1
      finalize(attempt, res)
    } else {
      sendJson(res, 201, { data: { deploymentId: "d1", version: "v1", uploadUrl: `${made.base}/blobs`, missing: [], limits: {} } })
    }
  })
  site = made
  return made
}

const live = { data: { version: "v1-abcd", status: "live", url: "https://demo.tenant.example.test" } }

describe("finalize", () => {
  it("returns the version and the site's url from the answer", async () => {
    const s = await server((_n, res) => sendJson(res, 200, live))
    const deployed = await deploySite(s.target, project.dir, FAST)
    expect(deployed).toEqual({ version: "v1-abcd", url: "https://demo.tenant.example.test" })
    expect(finalizesOf(s)[0]?.headers["x-org-id"]).toBe("org-1")
    expect(finalizesOf(s)[0]?.headers["x-supatype-environment"]).toBe("production")
  })

  // Cloud's refusals name their code in `error` and their reason in `message` (`sendJson` in
  // supatype-cloud), so the retry is tested against that shape.
  const NOT_PUSHED = { error: "pointer_not_pushed", message: "the live pointer was not pushed", statusCode: 502 }

  it("sends finalize again after a 502 pointer_not_pushed", async () => {
    const s = await server((n, res) => (n <= 2 ? sendJson(res, 502, NOT_PUSHED) : sendJson(res, 200, live)))
    const deployed = await deploySite(s.target, project.dir, FAST)
    expect(finalizesOf(s)).toHaveLength(3)
    expect(deployed.url).toBe("https://demo.tenant.example.test")
  })

  it("stops after three retries, saying the site is uploaded and finalize can be run again", async () => {
    const s = await server((_n, res) => sendJson(res, 502, NOT_PUSHED))
    await expect(deploySite(s.target, project.dir, FAST)).rejects.toThrow(/not live.*pointer was not pushed/s)
    expect(finalizesOf(s)).toHaveLength(4)
  })

  it("does not retry a 409 blobs_missing, and names the hashes", async () => {
    const s = await server((_n, res) => sendJson(res, 409, { code: "blobs_missing", error: "2 blobs are missing: aaa, bbb" }))
    await expect(deploySite(s.target, project.dir, FAST)).rejects.toThrow(/Finalizing failed.*aaa, bbb/s)
    expect(finalizesOf(s)).toHaveLength(1)
  })

  it("fails when the answer does not say the site is live", async () => {
    const s = await server((_n, res) => sendJson(res, 200, { data: { version: "v1", status: "uploading", url: "https://x.example.test" } }))
    await expect(deploySite(s.target, project.dir, FAST)).rejects.toThrow(/not live/)
  })

  it("fails when the answer has no url", async () => {
    const s = await server((_n, res) => sendJson(res, 200, { data: { version: "v1", status: "live" } }))
    await expect(deploySite(s.target, project.dir, FAST)).rejects.toThrow(/Unexpected response/)
  })
})
