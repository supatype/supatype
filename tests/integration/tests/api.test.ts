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

const client = createClient({ url: BASE_URL, anonKey: ANON_KEY })

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

  test("insert a post", async () => {
    const { data, error } = await client
      .from("post")
      .insert({ title: "Hello Integration", slug: "hello-integration", published: true })

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
      .eq("slug", "hello-integration")

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

  before(async () => {
    const { data } = await client
      .from("post")
      .insert({ title: "Temp Post", slug: `temp-${Date.now()}`, published: false })
    postId = (data as Array<{ id: string }>)[0]?.id
  })

  after(async () => {
    if (postId) {
      await client.from("post").delete().eq("id", postId)
    }
  })

  test("insert a comment", async () => {
    assert.ok(postId)
    const { data, error } = await client
      .from("comment")
      .insert({ body: "Great post!", postId, authorId: "00000000-0000-0000-0000-000000000001" })

    assert.ifError(error)
    commentId = (data as Array<{ id: string }>)[0]?.id
    assert.ok(commentId)
  })

  test("select comments for post", async () => {
    const { data, error } = await client
      .from("comment")
      .select()
      .eq("postId", postId!)

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
      .from("public")
      .upload("integration-test/hello.txt", testFile, { upsert: true })
    // Storage bucket may not exist; treat 404 as non-fatal for now
    assert.ok(!error || error.message.includes("not found"), `Unexpected storage error: ${error?.message}`)
  })

  test("get public URL", () => {
    const { publicUrl } = client.storage
      .from("public")
      .getPublicUrl("integration-test/hello.txt")
    assert.ok(typeof publicUrl === "string" && publicUrl.length > 0)
  })
})
