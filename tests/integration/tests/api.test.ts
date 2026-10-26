/**
 * Integration tests: run against a live supatype dev stack.
 *
 * Requires SUPATYPE_URL and SUPATYPE_ANON_KEY environment variables.
 * Run via: scripts/integration-test.sh
 */

import { strict as assert } from "node:assert"
import { test, describe, before, after } from "node:test"
import { createClient } from "@supatype/client"
import { at, stringColumn as strings } from "../lib/json.js"

const BASE_URL = process.env["SUPATYPE_URL"] ?? "http://localhost:54399"
const ANON_KEY = process.env["SUPATYPE_ANON_KEY"] ?? "anon-key-placeholder"
const SERVICE_ROLE_KEY = process.env["SUPATYPE_SERVICE_ROLE_KEY"]

const client = createClient({
  url: BASE_URL,
  anonKey: ANON_KEY,
  ...(SERVICE_ROLE_KEY !== undefined && SERVICE_ROLE_KEY !== "" && { serviceRoleKey: SERVICE_ROLE_KEY }),
})

// ── Health ─────────────────────────────────────────────────────────────────────

describe("health", () => {
  test("REST API responds", async () => {
    const res = await fetch(`${BASE_URL}/rest/v1/`)
    assert.ok(res.ok || res.status === 401, `Unexpected status: ${res.status}`)
  })

  test("auth API responds", async () => {
    const res = await fetch(`${BASE_URL}/auth/v1/health`)
    assert.ok(res.ok, `Auth health check failed: ${res.status}`)
  })
})

// ── Posts CRUD ─────────────────────────────────────────────────────────────────

describe("posts REST CRUD", () => {
  let createdId: string | undefined
  const slug = `hello-integration-${Date.now()}`

  test("insert a post", async () => {
    const { data, error } = await client
      .from("post")
      .insert({ title: "Hello Integration", slug })

    assert.ifError(error)
    assert.ok(Array.isArray(data) && data.length > 0, "No rows returned")
    assert.equal(data[0]?.["title"], "Hello Integration")
    createdId = strings(data, "id")[0]
  })

  test("select posts", async () => {
    const { data, error } = await client
      .from("post")
      .select()
      .eq("slug", slug)

    assert.ifError(error)
    assert.ok(Array.isArray(data) && data.length >= 1)
  })

  test("update a post", async () => {
    assert.ok(createdId, "No created post ID from insert test")
    const { data, error } = await client
      .from("post")
      .update({ title: "Hello Integration (updated)" })
      .eq("id", createdId)

    assert.ifError(error)
    assert.equal(data?.[0]?.["title"], "Hello Integration (updated)")
  })

  test("delete a post", async () => {
    assert.ok(createdId, "No created post ID from insert test")
    const { error } = await client
      .from("post")
      .delete()
      .eq("id", createdId)

    assert.ifError(error)
  })
})

// ── Writes filtered with or() ──────────────────────────────────────────────────

/**
 * A PATCH or DELETE filtered with `or` whose `select` leaves out the filtered column.
 *
 * PostgREST before 14.4 (PostgREST#3707) applied the filter to the returned representation as
 * well as to the write, so it referenced a column the representation did not carry. Both writes
 * failed with `column post.slug does not exist`, and the delete deleted nothing.
 */
describe("writes filtered with or()", () => {
  const stamp = Date.now()
  const slugs = ["first", "second", "third"].map((name) => `or-filter-${name}-${stamp}`)
  const [first = "", second = "", third = ""] = slugs
  const ids = new Map<string, string>()
  const firstTwo = `slug.eq.${first},slug.eq.${second}`

  const sortedIds = (rows: readonly Record<string, unknown>[] | null): string[] => strings(rows, "id").sort()

  before(async () => {
    const { data, error } = await client
      .from("post")
      .insert(slugs.map((slug) => ({ title: `Or filter ${slug}`, slug })))
    assert.ifError(error)
    const slugsBack = strings(data, "slug")
    strings(data, "id").forEach((id, i) => ids.set(slugsBack[i] ?? "", id))
    assert.equal(ids.size, 3)
  })

  after(async () => {
    await client.from("post").delete().in("slug", slugs)
  })

  test("update returns the rows it wrote", async () => {
    const { data, error } = await client
      .from("post")
      .update({ excerpt: "touched" })
      .or(firstTwo)
      .select("id")

    assert.ifError(error)
    assert.deepEqual(sortedIds(data), [ids.get(first), ids.get(second)].sort())
  })

  test("delete returns the rows it deleted and leaves the rest", async () => {
    const { data, error } = await client.from("post").delete().or(firstTwo).select("id")

    assert.ifError(error)
    assert.deepEqual(sortedIds(data), [ids.get(first), ids.get(second)].sort())

    const { data: left, error: readError } = await client.from("post").select("id").in("slug", slugs)
    assert.ifError(readError)
    assert.deepEqual(sortedIds(left), [ids.get(third)])
  })
})

// ── Comments CRUD ──────────────────────────────────────────────────────────────

describe("comments REST CRUD", () => {
  let postId: string | undefined
  let commentId: string | undefined
  let authorId: string | undefined

  before(async () => {
    const suffix = Date.now()
    const { data: authorRows, error: authorError } = await client
      .from("author")
      .insert({ email: `comment-test-${suffix}@example.com`, username: `comment-${suffix}`, role: "user" })
    assert.ifError(authorError)
    authorId = strings(authorRows, "id")[0]
    assert.ok(authorId)

    const { data, error } = await client
      .from("post")
      .insert({ title: "Temp Post", slug: `temp-${suffix}`, author_id: authorId })
    assert.ifError(error)
    postId = strings(data, "id")[0]
    assert.ok(postId)
  })

  after(async () => {
    if (postId) {
      await client.from("post").delete().eq("id", postId)
    }
    if (authorId) {
      await client.from("author").delete().eq("id", authorId)
    }
  })

  test("insert a comment", async () => {
    assert.ok(postId && authorId)
    const { data, error } = await client
      .from("comment")
      .insert({ body: "Great post!", post_id: postId, author_id: authorId })

    assert.ifError(error)
    commentId = strings(data, "id")[0]
    assert.ok(commentId)
  })

  test("select comments for post", async () => {
    const { data, error } = await client
      .from("comment")
      .select()
      .eq("post_id", postId!)

    assert.ifError(error)
    assert.ok(Array.isArray(data) && data.length >= 1)
  })

  test("delete a comment", async () => {
    if (!commentId) return
    const { error } = await client.from("comment").delete().eq("id", commentId)
    assert.ifError(error)
  })
})

// ── Storage ────────────────────────────────────────────────────────────────────

describe("storage", () => {
  const testFile = new Blob(["hello world"], { type: "text/plain" })

  test("upload a file", async () => {
    const { error } = await client.storage
      .from("avatars")
      .upload("integration-test/hello.txt", testFile, { upsert: true })
    // Bucket may not exist in MinIO until storage sync runs; still exercise the API path.
    assert.ok(
      !error || error.status === 404 || error.status === 500,
      `Unexpected storage error: ${error?.message}`,
    )
  })

  test("get public URL", () => {
    const { data } = client.storage
      .from("avatars")
      .getPublicUrl("integration-test/hello.txt")
    assert.ok(typeof data.publicUrl === "string" && data.publicUrl.length > 0)
  })
})

// ── Edge Functions ─────────────────────────────────────────────────────────────

describe("edge functions", () => {
  test("invoke ping function", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/ping`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(at(body, "ok"), true)
    assert.equal(at(body, "function"), "ping")
    assert.equal(at(body, "method"), "GET")
  })

  test("invoke echo function with JSON payload", async () => {
    const payload = { source: "integration", value: 42 }
    const res = await fetch(`${BASE_URL}/functions/v1/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(at(body, "ok"), true)
    assert.equal(at(body, "function"), "echo")
    assert.deepEqual(at(body, "body"), payload)
  })

  test("auth-required rejects missing authorization header", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/auth-required`)
    assert.equal(res.status, 401)
  })

  test("auth-required accepts Bearer authorization header", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/auth-required`, {
      headers: {
        Authorization: "Bearer integration-test-token",
      },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(at(body, "ok"), true)
    assert.equal(at(body, "function"), "auth-required")
  })

  test("env-check has runtime Supatype environment variables", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/env-check`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(at(body, "ok"), true)
    assert.equal(at(body, "hasSupatypeUrl"), true)
    assert.equal(at(body, "hasAnonKey"), true)
    // False by design, and the point of the least-privilege work: the worker withholds the
    // service role key and hands it back only to a route that declared it needs one, or to a
    // model hook. env-check declares nothing, so it must not see an ambient admin credential.
    // This assertion said true, from before that change, and had been failing CI since.
    assert.equal(at(body, "hasServiceRoleKey"), false)
  })
})
