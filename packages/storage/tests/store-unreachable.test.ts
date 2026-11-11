/**
 * 0.9.2 release test round 2 (R2-S4): with the S3 store unreachable at start, the service started
 * (as it should: the store may still be starting) and the first upload answered a bare
 * `{"error":"Internal server error"}` 500, the ECONNREFUSED only in the log. A request the store
 * cannot be reached for answers 503 with a code and a message naming the store.
 *
 * Nothing listens on port 1 (tests/support/s3-endpoint.ts), so the S3 client's error is a real one.
 */
import { createServer, type Server, type ServerResponse } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isShape, isString } from "../src/json.js"

const isRefusal = isShape({ code: isString, error: isString })

const saved = { ...process.env }
let server: Server | undefined

afterEach(async () => {
  process.env = { ...saved }
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

/** The service's modules with the store at a port nothing listens on. */
async function modulesAtDeadStore() {
  Object.assign(process.env, {
    JWT_SECRET: "store-unreachable-test-secret",
    DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
    S3_ENDPOINT: "http://127.0.0.1:1",
    S3_ACCESS_KEY: "id",
    S3_SECRET_KEY: "secret",
    S3_BUCKET: "shared",
  })
  vi.resetModules()
  return { s3: await import("../src/s3.js"), app: await import("../src/server.js") }
}

/** What a client sees when the service answers a request that failed with err. */
async function answerTo(answerFailure: (res: ServerResponse, err: unknown) => void, err: unknown) {
  const listening = createServer((_req, res) => answerFailure(res, err))
  server = listening
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve))
  const address = listening.address()
  if (address === null || typeof address === "string") throw new Error("the test server has no port")
  const res = await fetch(`http://127.0.0.1:${address.port}/`)
  return { status: res.status, body: await res.text() }
}

describe("a request the S3 store cannot be reached for", () => {
  it("answers 503 with a code and the store's address, not a bare 500", async () => {
    const { s3, app } = await modulesAtDeadStore()
    const err = await s3.putObject("avatars", "a.txt/v1", Buffer.from("x"), "text/plain").then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeDefined()
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const { status, body } = await answerTo(app.answerFailure, err)
    error.mockRestore()

    expect(status).toBe(503)
    const answer: unknown = JSON.parse(body)
    if (!isRefusal(answer)) throw new Error(`not a refusal: ${body}`)
    expect(answer.code).toBe("store_unreachable")
    expect(answer.error).toMatch(/^The S3 store at http:\/\/127\.0\.0\.1:1 cannot be reached \(ECONNREFUSED\)/)
  })

  // The database client passes Node's socket error through with the same codes: a Postgres that is
  // down must not be reported as the S3 store.
  it("does not take a database connection refused for the S3 store", async () => {
    const { app } = await modulesAtDeadStore()
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })

    const { status } = await answerTo(app.answerFailure, refused)
    error.mockRestore()

    expect(status).toBe(500)
  })

  it("still answers any other failure with the plain 500", async () => {
    const { app } = await modulesAtDeadStore()
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const { status, body } = await answerTo(app.answerFailure, new Error("something else"))
    error.mockRestore()

    expect(status).toBe(500)
    expect(JSON.parse(body)).toEqual({ error: "Internal server error" })
  })
})
