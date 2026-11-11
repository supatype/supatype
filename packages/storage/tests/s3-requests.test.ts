/**
 * 0.9.2 release test (N-FF10): on MinIO RELEASE.2024-11-07 every remove answered 200 and left the
 * bytes in S3, and emptying a bucket answered 500, because DeleteObjects reached it with a CRC32
 * checksum and no Content-MD5, which that release (and other older S3-compatible stores) refuse with
 * `MissingContentMD5`. The SDK computes no MD5 since 3.729, whatever `requestChecksumCalculation`
 * says, so the service adds one itself.
 *
 * 0.9.2 release test (N-S23): a wrong `S3_BUCKET` started cleanly and the first upload answered 500.
 * The service now asks S3 for the bucket at start and refuses to start without it.
 *
 * A local HTTP server stands in for S3 and records what the client really sends.
 */
import { createHash } from "node:crypto"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

interface Received {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

const received: Received[] = []
let server: Server | undefined
let endpoint = ""
/** What the recording server answers a HEAD (HeadBucket) with. */
let headStatus = 200
/** Set to leave every HEAD unanswered, like an endpoint that accepts connections and stalls. */
let headHangs = false
const saved = { ...process.env }

const XMLNS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'
/** What S3 answers a DeleteObjects with: every key deleted. */
const DELETED = `<?xml version="1.0" encoding="UTF-8"?><DeleteResult ${XMLNS}></DeleteResult>`
/** What S3 answers a listing with: one key under the photos bucket's prefix. */
const LISTED = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult ${XMLNS}><IsTruncated>false</IsTruncated><Contents><Key>photos/cat.png/v1</Key><Size>3</Size></Contents></ListBucketResult>`

/** The recording server's answer to `url`. */
function answer(url: string): string {
  if (url.includes("delete")) return DELETED
  return url.includes("list-type=2") ? LISTED : ""
}

beforeAll(async () => {
  const recorder = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") })
      if (req.method === "HEAD" && headHangs) return
      res.writeHead(req.method === "HEAD" ? headStatus : 200, { "content-type": "application/xml" })
      res.end(answer(req.url ?? ""))
    })
  })
  server = recorder
  await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve))
  const address = recorder.address()
  if (address === null || typeof address === "string") throw new Error("the recording server has no port")
  endpoint = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
})

afterEach(() => {
  process.env = { ...saved }
  received.length = 0
  headStatus = 200
  headHangs = false
})

/** A path that never exists, so the SDK's chain finds no `~/.aws` on the machine running the tests. */
const NO_AWS_FILE = "/nonexistent/supatype-s3-requests-test"

/** The S3 module at the recording server, with fixed keys and nothing from the machine's AWS setup. */
async function s3AtRecorder(vars: Record<string, string>) {
  for (const key of Object.keys(process.env)) if (key.startsWith("S3_") || key.startsWith("AWS_")) delete process.env[key]
  Object.assign(process.env, {
    JWT_SECRET: "s3-requests-test-secret",
    AWS_SHARED_CREDENTIALS_FILE: NO_AWS_FILE,
    AWS_CONFIG_FILE: NO_AWS_FILE,
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY: "id",
    S3_SECRET_KEY: "secret",
    ...vars,
  })
  vi.resetModules()
  return import("../src/s3.js")
}

const md5 = (body: string) => createHash("md5").update(body).digest("base64")

describe("Content-MD5 on the requests S3 requires a checksum on", () => {
  it("sends DeleteObjects with the Content-MD5 of its body (one S3 bucket)", async () => {
    const s3 = await s3AtRecorder({ S3_BUCKET: "shared" })
    await s3.deleteObjects("docs", ["a.txt", "b.txt"])
    const [request] = received
    expect(request?.method).toBe("POST")
    expect(request?.url).toMatch(/^\/shared\/?\?delete/)
    expect(request?.body).toContain("<Key>docs/a.txt</Key>")
    expect(request?.headers["content-md5"]).toBe(md5(request?.body ?? ""))
  })

  it("sends the DeleteObjects that deletes a bucket's prefix with Content-MD5 too", async () => {
    const s3 = await s3AtRecorder({ S3_BUCKET: "shared" })
    await s3.deleteBucket("photos")
    const deleted = received.find((r) => r.url.includes("delete"))
    expect(deleted?.body).toContain("<Key>photos/cat.png/v1</Key>")
    expect(deleted?.headers["content-md5"]).toBe(md5(deleted?.body ?? ""))
  })

  it("sends a bucket policy with Content-MD5 (an S3 bucket per Supatype bucket)", async () => {
    const s3 = await s3AtRecorder({})
    await s3.applyRawBucketPolicy("photos", '{"Version":"2012-10-17","Statement":[]}')
    const put = received.find((r) => r.method === "PUT" && r.url.includes("policy"))
    expect(put?.headers["content-md5"]).toBe(md5(put?.body ?? ""))
  })

  it("leaves an upload's body to the SDK's own checksum and hashes no file twice", async () => {
    const s3 = await s3AtRecorder({ S3_BUCKET: "shared" })
    await s3.putObject("docs", "a.txt", Buffer.from("hello"), "text/plain")
    const [put] = received
    expect(put?.headers["content-md5"]).toBeUndefined()
    expect(put?.headers["x-amz-checksum-crc32"]).toBeDefined()
  })
})

describe("the one S3 bucket, checked at start", () => {
  it("starts when S3 has the bucket", async () => {
    const s3 = await s3AtRecorder({ S3_BUCKET: "shared" })
    await expect(s3.checkOneBucket()).resolves.toBeUndefined()
    expect(received.map((r) => `${r.method} ${r.url}`)).toEqual(["HEAD /shared/"])
  })

  it("refuses to start when S3 has no bucket by that name, naming it and the setting", async () => {
    headStatus = 404
    const s3 = await s3AtRecorder({ S3_BUCKET: "shraed" })
    await expect(s3.checkOneBucket()).rejects.toThrow(/S3_BUCKET is "shraed".*no bucket by that name/)
  })

  // MinIO answers 403 for a bucket that is not there when the keys may only reach their own one.
  it("refuses to start when S3 refuses these keys the bucket", async () => {
    headStatus = 403
    const s3 = await s3AtRecorder({ S3_BUCKET: "someone-elses" })
    // The whole sentence: round 2 (R2-S3) found "refuses these keys that bucket", words missing.
    await expect(s3.checkOneBucket()).rejects.toThrow(/S3_BUCKET is "someone-elses".* refuses these keys access to that bucket \(403\).*s3:ListBucket/)
  })

  it("starts anyway, and says so, when the store does not answer: it may still be starting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const s3 = await s3AtRecorder({ S3_BUCKET: "shared", S3_ENDPOINT: "http://127.0.0.1:1" })
    await expect(s3.checkOneBucket()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not check S3_BUCKET "shared" at http:\/\/127\.0\.0\.1:1, starting anyway/))
    warn.mockRestore()
  })

  it("asks once, not again and again, when the store answers with an error worth retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    headStatus = 503
    const s3 = await s3AtRecorder({ S3_BUCKET: "shared" })
    await expect(s3.checkOneBucket()).resolves.toBeUndefined()
    expect(received.filter((r) => r.method === "HEAD")).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not check S3_BUCKET "shared".*starting anyway/))
    warn.mockRestore()
  })

  it("gives up after a few seconds on a store that never answers, and starts anyway", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    headHangs = true
    const s3 = await s3AtRecorder({ S3_BUCKET: "shared" })
    const started = Date.now()
    await expect(s3.checkOneBucket()).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not check S3_BUCKET "shared".*starting anyway/))
    warn.mockRestore()
  }, 10_000)

  it("asks nothing in a bucket per Supatype bucket, where there is no one bucket to check", async () => {
    const s3 = await s3AtRecorder({})
    await s3.checkOneBucket()
    expect(received).toEqual([])
  })
})
