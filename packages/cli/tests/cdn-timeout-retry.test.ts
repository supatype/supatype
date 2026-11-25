import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { portOf } from "./support/ports.js"

/**
 * A CDN that hangs the first request for a path and answers the second, standing in for the
 * stalled connection that used to hang `supatype self-update` forever.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
const hits = new Map<string, number>()

function hangOnceThen(body: string): Handler {
  return (req, res) => {
    const path = req.url ?? ""
    const n = (hits.get(path) ?? 0) + 1
    hits.set(path, n)
    if (n === 1) return // never answers; the client must give up and retry
    res.writeHead(200).end(body)
  }
}

async function startServer(handler: Handler): Promise<void> {
  server = createServer(handler)
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  base = `http://127.0.0.1:${portOf(server)}`
}

beforeEach(() => {
  hits.clear()
  vi.resetModules()
  vi.stubEnv("SUPATYPE_FETCH_TIMEOUT_MS", "300")
  vi.stubEnv("SUPATYPE_RETRY_DELAY_MS", "1")
  vi.stubEnv("SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS", "1")
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise<void>((ok) => server.close(() => ok()))
})

describe("CLI self-download against a slow CDN", () => {
  it("retries a hung latest.json and returns the version", async () => {
    await startServer(hangOnceThen('{"version":"1.2.3"}'))
    vi.stubEnv("SUPATYPE_CDN_BASE", base)
    const { fetchStandaloneCliLatestVersion } = await import("../src/cli-standalone.js")
    await expect(fetchStandaloneCliLatestVersion()).resolves.toBe("1.2.3")
    expect(hits.get("/cli/latest.json")).toBe(2)
  })

  it("retries a hung checksums manifest", async () => {
    await startServer(hangOnceThen("abc123  supatype-cli.tar.gz\n"))
    const { fetchChecksums } = await import("../src/binary-cache.js")
    const match = await fetchChecksums(`${base}/checksums.sha256`, `${base}/checksums.sha256.minisig`, "supatype-cli.tar.gz")
    expect(match.checksum).toBe("abc123")
    expect(hits.get("/checksums.sha256")).toBe(2)
  })

  it("names the URL and suggests trying again when every attempt hangs", async () => {
    await startServer(() => undefined)
    vi.stubEnv("SUPATYPE_CDN_BASE", base)
    const { fetchStandaloneCliLatestVersion } = await import("../src/cli-standalone.js")
    const failure = fetchStandaloneCliLatestVersion()
    await expect(failure).rejects.toThrow(`${base}/cli/latest.json`)
    await expect(failure).rejects.toThrow(/try again/i)
  })
})
