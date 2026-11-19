import { createServer, type IncomingMessage, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import {
  deletePublicEnv,
  listPublicEnv,
  pushPublicEnv,
  setPublicEnv,
  type PublicEnvEntry,
} from "../src/site-public-env.js"
import type { DeployTarget } from "../src/resolve-target.js"
import { portOf } from "./support/ports.js"

/** What the control plane saw, and what it answers. */
interface Seen {
  method: string
  url: string
  environment: string | undefined
  body: unknown
}

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  const text = Buffer.concat(chunks).toString("utf8")
  return text === "" ? undefined : JSON.parse(text)
}

/** A control plane that records each request and answers with `reply`. */
async function controlPlane(reply: (seen: Seen) => { status: number; body: unknown }): Promise<{ target: DeployTarget; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    void bodyOf(req).then((body) => {
      const environment = req.headers["x-supatype-environment"]
      const record: Seen = { method: req.method ?? "", url: req.url ?? "", environment: typeof environment === "string" ? environment : undefined, body }
      seen.push(record)
      const answer = reply(record)
      res.writeHead(answer.status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(answer.body))
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const target: DeployTarget = {
    mode: "cloud",
    environment: "staging",
    projectRef: "demo",
    apiBaseUrl: `http://127.0.0.1:${portOf(server)}`,
    apiPrefix: "/api/v1",
    token: "t",
    link: null,
  }
  return { target, seen }
}

const ok = (data: unknown) => ({ status: 200, body: { data } })

describe("pushPublicEnv", () => {
  it("sends the environment's values to the target, for its environment", async () => {
    const { target, seen } = await controlPlane(() => ok({ values: ["A"] }))
    await pushPublicEnv(target, { A: "1" })
    expect(seen).toEqual([{ method: "PUT", url: "/api/v1/projects/demo/site/env/config", environment: "staging", body: { values: { A: "1" } } }])
  })

  it("sends an empty set, which clears what an earlier push wrote", async () => {
    const { target, seen } = await controlPlane(() => ok({ values: [] }))
    await pushPublicEnv(target, {})
    expect(seen[0]?.body).toEqual({ values: {} })
  })

  it("is not an error to clear on a server from before public values", async () => {
    const { target } = await controlPlane(() => ({ status: 404, body: { error: "not_found", message: "Route not found" } }))
    await expect(pushPublicEnv(target, {})).resolves.toBeUndefined()
  })

  it("says the server is too old when it has values to send", async () => {
    const { target } = await controlPlane(() => ({ status: 404, body: { error: "not_found", message: "Route not found" } }))
    await expect(pushPublicEnv(target, { A: "1" })).rejects.toThrow(/does not serve public values/)
  })

  it("passes a refusal on, as the server worded it", async () => {
    const { target } = await controlPlane(() => ({ status: 400, body: { error: "validation_error", message: "STRIPE looks like a private key" } }))
    await expect(pushPublicEnv(target, { STRIPE: "x" })).rejects.toThrow(/STRIPE looks like a private key/)
  })

  it("refuses a value that looks secret before any request", async () => {
    const { target, seen } = await controlPlane(() => ok({}))
    await expect(pushPublicEnv(target, { STRIPE: "sk_live_51Habcdefghijkl" })).rejects.toThrow(/STRIPE/)
    expect(seen).toEqual([])
  })
})

describe("listPublicEnv", () => {
  it("reads the effective values with where each is set", async () => {
    const entries: PublicEnvEntry[] = [
      { name: "A", value: "1", source: "config" },
      { name: "B", value: "2", source: "studio" },
    ]
    const { target, seen } = await controlPlane(() => ok({ entries }))
    expect(await listPublicEnv(target)).toEqual(entries)
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/v1/projects/demo/site/env", environment: "staging" })
  })

  it("refuses an answer that is not entries", async () => {
    const { target } = await controlPlane(() => ok({ entries: [{ name: "A" }] }))
    await expect(listPublicEnv(target)).rejects.toThrow(/Unexpected response/)
  })
})

describe("setPublicEnv and deletePublicEnv", () => {
  it("sets one value by name", async () => {
    const { target, seen } = await controlPlane(() => ok({ name: "MAPS_KEY", value: "m", source: "studio" }))
    await setPublicEnv(target, "MAPS_KEY", "m")
    expect(seen).toEqual([{ method: "PUT", url: "/api/v1/projects/demo/site/env/MAPS_KEY", environment: "staging", body: { value: "m" } }])
  })

  it("refuses a bad name or a secret before any request", async () => {
    const { target, seen } = await controlPlane(() => ok({}))
    await expect(setPublicEnv(target, "lower", "x")).rejects.toThrow(/lower/)
    await expect(setPublicEnv(target, "K", "-----BEGIN PRIVATE KEY-----")).rejects.toThrow(/private key/)
    expect(seen).toEqual([])
  })

  it("passes on that a value is set in the config", async () => {
    const { target } = await controlPlane(() => ({ status: 409, body: { error: "set_in_config", message: "MAPS_KEY is set in supatype.config.ts" } }))
    await expect(setPublicEnv(target, "MAPS_KEY", "m")).rejects.toThrow(/set in supatype\.config\.ts/)
  })

  it("removes one by name", async () => {
    const { target, seen } = await controlPlane(() => ok({ name: "MAPS_KEY" }))
    await deletePublicEnv(target, "MAPS_KEY")
    expect(seen).toEqual([{ method: "DELETE", url: "/api/v1/projects/demo/site/env/MAPS_KEY", environment: "staging", body: undefined }])
  })
})
