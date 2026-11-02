import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import { describe, expect, it, vi } from "vitest"

vi.mock("../src/db.js", () => ({ getBucket: vi.fn() }))
vi.stubEnv("JWT_SECRET", "body-field-names-test-secret")

const objects = await import("../src/routes/objects.js")

/**
 * The object routes refused a body of the wrong type with "does not have the fields this route
 * reads", naming none, while the bucket routes named the field. Every route names it now.
 */
function context(body: unknown): Parameters<typeof objects.listObjects>[0] {
  const req = new IncomingMessage(new Socket())
  req.push(JSON.stringify(body))
  req.push(null)
  const res = new ServerResponse(new IncomingMessage(new Socket()))
  return { req, res, jwt: null, params: { bucket: "b", wildcard: "a.txt" }, url: new URL("http://s/object/list/b") }
}

describe("an object route given a field of the wrong type", () => {
  it("names the field when listing", async () => {
    await expect(objects.listObjects(context({ limit: "5" }))).rejects.toThrow("The request body's limit does not have the type")
  })

  it("names the field when signing a URL", async () => {
    await expect(objects.createSignedUrl(context({ expiresIn: "60" }))).rejects.toThrow("The request body's expiresIn does not have the type")
  })
})
