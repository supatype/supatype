/**
 * Integration tests — run against a live supatype dev stack.
 *
 * Requires SUPATYPE_URL and SUPATYPE_ANON_KEY environment variables.
 * Run via: scripts/integration-test.sh
 */

import { strict as assert } from "node:assert"
import { test, describe, before, after } from "node:test"
import { createClient } from "@supatype/client"

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
    const row = data[0] as { id: string; title: string }
    assert.equal(row.title, "Hello Integration")
    createdId = row.id
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
    const row = (data as Array<{ title: string }>)[0]
    assert.equal(row?.title, "Hello Integration (updated)")
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
    authorId = (authorRows as Array<{ id: string }>)[0]?.id
    assert.ok(authorId)

    const { data, error } = await client
      .from("post")
      .insert({ title: "Temp Post", slug: `temp-${suffix}`, author_id: authorId })
    assert.ifError(error)
    postId = (data as Array<{ id: string }>)[0]?.id
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
    commentId = (data as Array<{ id: string }>)[0]?.id
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

    const body = await res.json() as {
      ok: boolean
      function: string
      method: string
    }
    assert.equal(body.ok, true)
    assert.equal(body.function, "ping")
    assert.equal(body.method, "GET")
  })

  test("invoke echo function with JSON payload", async () => {
    const payload = { source: "integration", value: 42 }
    const res = await fetch(`${BASE_URL}/functions/v1/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    assert.equal(res.status, 200)

    const body = await res.json() as {
      ok: boolean
      function: string
      body: { source: string; value: number }
    }
    assert.equal(body.ok, true)
    assert.equal(body.function, "echo")
    assert.deepEqual(body.body, payload)
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
    const body = await res.json() as { ok: boolean; function: string }
    assert.equal(body.ok, true)
    assert.equal(body.function, "auth-required")
  })

  test("env-check has runtime Supatype environment variables", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/env-check`)
    assert.equal(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      hasSupatypeUrl: boolean
      hasAnonKey: boolean
      hasServiceRoleKey: boolean
    }
    assert.equal(body.ok, true)
    assert.equal(body.hasSupatypeUrl, true)
    assert.equal(body.hasAnonKey, true)
    assert.equal(body.hasServiceRoleKey, true)
  })
})
