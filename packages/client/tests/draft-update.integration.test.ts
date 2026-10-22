import { createHmac } from "node:crypto"
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createClient, forgetRegisteredDraftModels, registerDraftModels, type AnyDatabase } from "../src/index.js"

/**
 * An editor's update on a drafts model, against a real PostgREST and Postgres.
 *
 * The same setup as `draft-insert.integration.test.ts`: `posts` from the engine's `versioned_blog`
 * fixture with read `published_at <= now()` and create and update for the `editor` role, and an API
 * editor with no Studio membership. The update saves a draft and the public keeps reading what was
 * published, until the update asks to publish; a raw `PATCH` of the table is refused by the database.
 *
 * Needs `SUPATYPE_DRAFTS_REST_URL` and `SUPATYPE_DRAFTS_JWT_SECRET`, as that suite does. Skips
 * otherwise.
 */
const restUrl = process.env["SUPATYPE_DRAFTS_REST_URL"]
const jwtSecret = process.env["SUPATYPE_DRAFTS_JWT_SECRET"]
const EDITOR = "11111111-1111-1111-1111-111111111111"

/** An HS256 token carrying `claims`, signed as the auth server signs one. */
function token(claims: Record<string, unknown>): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url")
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 })}`
  return `${unsigned}.${createHmac("sha256", jwtSecret ?? "").update(unsigned).digest("base64url")}`
}

const ANON_KEY = (): string => token({ role: "anon" })
const EDITOR_SESSION = (): string => token({ sub: EDITOR, role: "authenticated", app_metadata: { role: "editor" } })

/** Forward `/rest/v1/<rest>` to PostgREST's `/<rest>`, as the gateway mounts it. */
function forward(upstream: URL) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? "/").replace(/^\/rest\/v1/, "")
    const out = request(new URL(path, upstream), { method: req.method, headers: { ...req.headers, host: upstream.host } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    out.on("error", () => res.writeHead(502).end())
    req.pipe(out)
  }
}

describe.skipIf(restUrl === undefined || jwtSecret === undefined)("an API editor's update on a drafts model", () => {
  let proxy: Server
  let base = ""

  beforeAll(async () => {
    proxy = createServer(forward(new URL(restUrl ?? "")))
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    const address: AddressInfo | string | null = proxy.address()
    base = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : ""
    registerDraftModels({ version: 1, tables: { posts: { primaryKey: "id" } } })
  })

  afterAll(async () => {
    forgetRegisteredDraftModels()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  })

  const editor = () =>
    createClient<AnyDatabase>({ url: base, anonKey: ANON_KEY(), headers: { Authorization: `Bearer ${EDITOR_SESSION()}` } })
  const reader = () => createClient<AnyDatabase>({ url: base, anonKey: ANON_KEY() })

  /** A post the editor has created and published, by its id. */
  async function publishedPost(title: string): Promise<string> {
    const { data } = await editor().from("posts").insert({ title }).select("id").single()
    const id = String(data?.["id"])
    const published = await editor().rpc("publish", { model_table: "posts", record_id: id }, { schema: "supatype" })
    expect(published.error).toBeNull()
    return id
  }

  it("saves a draft, returns it, and leaves what the public reads alone", async () => {
    const stamp = Date.now()
    const id = await publishedPost(`Published ${stamp}`)

    const { data, error } = await editor().from("posts").update({ title: `Draft ${stamp}` }).eq("id", id).select("title")

    expect(error).toBeNull()
    expect(data).toEqual([{ title: `Draft ${stamp}` }])
    const publicly = await reader().from("posts").select("title").eq("id", id)
    expect(publicly).toMatchObject({ data: [{ title: `Published ${stamp}` }], error: null })
    const drafted = await editor().from("posts").draft().select("title").eq("id", id)
    expect(drafted.data).toEqual([{ title: `Draft ${stamp}` }])
  })

  it("publishes in the same call with { publish: true }, so the public reads the new version", async () => {
    const stamp = Date.now()
    const id = await publishedPost(`Before ${stamp}`)

    const { error } = await editor().from("posts").update({ title: `After ${stamp}` }, { publish: true }).eq("id", id)

    expect(error).toBeNull()
    const publicly = await reader().from("posts").select("title").eq("id", id)
    expect(publicly).toMatchObject({ data: [{ title: `After ${stamp}` }], error: null })
    // Recorded as a version, which is what the draft view reads, and that version is the live one.
    const newest = await editor().from("posts").draft().select("title").eq("id", id)
    expect(newest.data).toEqual([{ title: `After ${stamp}` }])
    const again = await editor().rpc("publish", { model_table: "posts", record_id: id }, { schema: "supatype" })
    expect(again.error?.message).toContain("is already live")
  })

  it("is refused as a raw PATCH, naming drafts and publish", async () => {
    const stamp = Date.now()
    const id = await publishedPost(`Raw ${stamp}`)

    const res = await fetch(`${base}/rest/v1/posts?id=eq.${id}`, {
      method: "PATCH",
      headers: { apikey: ANON_KEY(), Authorization: `Bearer ${EDITOR_SESSION()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Patched ${stamp}` }),
    })
    const refusal: unknown = await res.json()

    expect(res.status).toBe(403)
    expect(refusal).toMatchObject({ code: "42501" })
    expect(JSON.stringify(refusal)).toContain("posts has drafts")
    const publicly = await reader().from("posts").select("title").eq("id", id)
    expect(publicly.data).toEqual([{ title: `Raw ${stamp}` }])
  })
})
