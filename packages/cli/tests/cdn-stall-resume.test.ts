import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { portOf } from "./helpers/listen.js"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { withRetry } from "../src/binary-cache.js"
import { cdnGet, downloadToFile } from "../src/cdn-fetch.js"

/**
 * Downloads fail on a stall, not on total time, and a retry resumes from the bytes already on disk.
 * The stall window is short here (SUPATYPE_FETCH_TIMEOUT_MS) so "slower than the old 120 s limit"
 * can be shown in about a second.
 */
const PAYLOAD = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 251))
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex")

let server: Server
let base: string
let dir: string
let ranges: Array<string | undefined>

async function serve(handler: (req: IncomingMessage, res: ServerResponse, attempt: number) => void): Promise<void> {
  let attempt = 0
  ranges = []
  server = createServer((req, res) => {
    ranges.push(req.headers["range"])
    handler(req, res, ++attempt)
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  base = `http://127.0.0.1:${portOf(server)}`
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-resume-"))
  vi.stubEnv("SUPATYPE_FETCH_TIMEOUT_MS", "400")
  vi.stubEnv("SUPATYPE_RETRY_DELAY_MS", "1")
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise<void>((ok) => server.close(() => ok()))
  rmSync(dir, { recursive: true, force: true })
})

const dest = (): string => join(dir, "archive.bin")
const download = (): Promise<void> => withRetry(() => downloadToFile(`${base}/a.tar.gz`, dest(), "supatype 9.9.9"))

describe("stall detection", () => {
  it("fails when the body stalls mid-transfer, naming the URL and the window", async () => {
    await serve((_req, res) => {
      res.writeHead(200, { "content-length": String(PAYLOAD.length) })
      res.write(PAYLOAD.subarray(0, 500)) // then nothing, ever
    })
    const started = Date.now()
    const failure = downloadToFile(`${base}/a.tar.gz`, dest(), "supatype 9.9.9")
    await expect(failure).rejects.toThrow(`${base}/a.tar.gz`)
    await expect(failure).rejects.toThrow(/no data for/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("does not kill a slow server that keeps sending, however long the total takes", async () => {
    await serve((_req, res) => {
      res.writeHead(200, { "content-length": String(PAYLOAD.length) })
      let sent = 0
      const timer = setInterval(() => {
        res.write(PAYLOAD.subarray(sent, sent + 300))
        sent += 300
        if (sent >= PAYLOAD.length) { clearInterval(timer); res.end() }
      }, 150) // about 1.5 s in all, well past a 400 ms total limit, never 400 ms silent
    })
    await downloadToFile(`${base}/a.tar.gz`, dest(), "supatype 9.9.9")
    expect(sha(readFileSync(dest()))).toBe(sha(PAYLOAD))
  })
})

describe("resuming", () => {
  it("retries with a Range from the bytes already received and ends with the whole file", async () => {
    await serve((req, res, attempt) => {
      if (attempt === 1) {
        res.writeHead(200, { "content-length": String(PAYLOAD.length), "accept-ranges": "bytes" })
        res.write(PAYLOAD.subarray(0, 1000))
        setTimeout(() => res.destroy(), 50)
        return
      }
      const from = Number(/bytes=(\d+)-/.exec(req.headers["range"] ?? "")?.[1] ?? 0)
      res.writeHead(206, {
        "content-length": String(PAYLOAD.length - from),
        "content-range": `bytes ${from}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      })
      res.end(PAYLOAD.subarray(from))
    })
    await download()
    expect(ranges).toEqual([undefined, "bytes=1000-"])
    expect(sha(readFileSync(dest()))).toBe(sha(PAYLOAD))
  })

  it("starts again from zero when the retry answers 200 instead of 206", async () => {
    await serve((_req, res, attempt) => {
      res.writeHead(200, { "content-length": String(PAYLOAD.length) })
      if (attempt === 1) {
        res.write(PAYLOAD.subarray(0, 1000))
        setTimeout(() => res.destroy(), 50)
        return
      }
      res.end(PAYLOAD)
    })
    await download()
    expect(ranges[1]).toBe("bytes=1000-")
    expect(readFileSync(dest()).length).toBe(PAYLOAD.length)
    expect(sha(readFileSync(dest()))).toBe(sha(PAYLOAD))
  })
})

describe("small files use the same rule", () => {
  it("reads a manifest that trickles in past the stall window in total", async () => {
    await serve((_req, res) => {
      res.writeHead(200)
      let n = 0
      const timer = setInterval(() => {
        res.write("line\n")
        if (++n === 10) { clearInterval(timer); res.end() }
      }, 100)
    })
    const resp = await cdnGet(`${base}/checksums.sha256`)
    expect(resp.text()).toBe("line\n".repeat(10))
  })
})

describe("the retry line", () => {
  it("says each failure as one sentence, with no doubled full stop before the wait", async () => {
    const lines: string[] = []
    vi.spyOn(console, "error").mockImplementation((line: string) => { lines.push(line) })
    let calls = 0
    await withRetry(async () => {
      if (++calls === 1) throw new Error("Could not fetch x: no data for 1s. This is usually a blip; try again.")
      return "ok"
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("again..")
    expect(lines[0]).toContain("try again. Retrying in")
  })
})
