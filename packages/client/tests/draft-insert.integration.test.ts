import { createHmac } from "node:crypto"
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createClient, forgetRegisteredDraftModels, registerDraftModels, type AnyDatabase } from "../src/index.js"

/**
 * An editor's insert on a drafts model whose read rule hides unpublished records, against a real
 * PostgREST and Postgres.
 *
 * The model is `posts` from the engine's `versioned_blog` fixture with the access rules of a real
 * blog: read `published_at <= now()`, create and update for the `editor` role. The caller is an API
 * editor (the `authenticated` role with `app_metadata.role = "editor"`) with no Studio membership, so
 * nothing shows them every draft. A plain insert asking for the row back is refused for them with
 * `42501`, since Postgres checks the returned row against the read rule before anything has made it
 * visible to its author; the client's insert goes through `supatype.create_record` instead.
 *
 * Needs `SUPATYPE_DRAFTS_REST_URL` (PostgREST's root, exposing `public`, `draft` and `supatype`)
 * and `SUPATYPE_DRAFTS_JWT_SECRET` (its JWT secret), with that schema pushed by the engine. Skips
 * otherwise. PostgREST serves at its root, so a small proxy here strips `/rest/v1` as the gateway
 * does.
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

describe.skipIf(restUrl === undefined || jwtSecret === undefined)("an API editor's insert on a drafts model", () => {
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

  it("creates the record and returns the row an insert returns", async () => {
    const title = `Written by the client ${Date.now()}`
    const { data, error } = await editor()
      .from("posts")
      .insert({ title, body: { en: "Hello" } })
      .select()
      .single()

    expect(error).toBeNull()
    expect(data).toMatchObject({ title, body: { en: "Hello" }, published_at: null })
    expect(typeof data?.["id"]).toBe("string")
  })

  it("leaves the record an unpublished draft: its author reads it, the public does not", async () => {
    const title = `Still a draft ${Date.now()}`
    const { data } = await editor().from("posts").insert({ title }).select("id").single()
    const id = String(data?.["id"])

    const drafted = await editor().from("posts").draft().select("title").eq("id", id)
    const publicly = await reader().from("posts").select("id").eq("id", id)
    expect(drafted.data).toEqual([{ title }])
    expect(publicly).toMatchObject({ data: [], error: null })
  })

  it("creates several records in one insert and returns them in the order sent", async () => {
    const stamp = Date.now()
    const titles = [`Batch first ${stamp}`, `Batch second ${stamp}`]
    const { data, error } = await editor()
      .from("posts")
      .insert(titles.map((title) => ({ title, body: { en: title } })))
      .select("title, body")

    expect(error).toBeNull()
    expect(data).toEqual(titles.map((title) => ({ title, body: { en: title } })))
  })

  it("creates none of them when one is refused", async () => {
    const first = `Refused batch ${Date.now()}`
    const { data, error } = await editor()
      .from("posts")
      .insert([{ title: first }, { title: null }])

    expect(data).toBeNull()
    expect(error).toMatchObject({ code: "23502" })
    const drafted = await editor().from("posts").draft().select("title").eq("title", first)
    expect(drafted).toMatchObject({ data: [], error: null })
  })
})
