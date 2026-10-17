/**
 * Realtime integration: proxied WebSocket, WAL CDC, RLS, filters, presence/broadcast.
 *
 * Phase 10.6: F15 (CDC + latency), F17 (RLS isolation).
 */

import { strict as assert } from "node:assert"
import { test, describe, before } from "node:test"
import type { RealtimePayload } from "@supatype/client"
import { at, stringColumn } from "../lib/json.js"
import {
  adminClient,
  anonClient,
  BASE_URL,
  newSubscriptionRow,
  REALTIME_LATENCY_MS,
  requireKeys,
  signUpTestUser,
  sleep,
  userRealtimeClient,
  waitForEvents,
  waitForQuiet,
  waitForSubscribe,
} from "./realtime-helpers.js"

before(() => {
  requireKeys()
})

describe("realtime (F15)", () => {
  test("realtime health via server proxy", async () => {
    const res = await fetch(`${BASE_URL}/realtime/v1/health`)
    assert.ok(res.ok, `realtime health failed: ${res.status}`)
    const body = await res.json()
    assert.equal(at(body, "status"), "ok")
  })

  test("INSERT on post emits postgres_changes within latency budget", async () => {
    const client = anonClient()
    const admin = adminClient()
    const slug = `rt-insert-${Date.now()}`
    const events: RealtimePayload<Record<string, unknown>>[] = []

    // F11 + F15: typed table subscribe (not raw channel())
    const { channel, unsubscribe } = client.from("post").subscribe(
      (payload) => events.push(payload),
      { event: "INSERT", filter: `slug=eq.${slug}` },
    )

    try {
      await waitForSubscribe((cb) => channel.subscribe(cb))
      await sleep(300)

      const started = Date.now()
      const { error } = await admin.from("post").insert({ title: "Realtime INSERT", slug })
      assert.ifError(error)

      await waitForEvents(() => events.length, 1)
      const elapsed = Date.now() - started
      assert.ok(elapsed <= REALTIME_LATENCY_MS, `INSERT event took ${elapsed}ms (budget ${REALTIME_LATENCY_MS}ms)`)

      assert.equal(events[0]?.eventType, "INSERT")
      assert.equal(events[0]?.table, "post")
      assert.equal(events[0]?.new?.["slug"], slug)
    } finally {
      unsubscribe()
      client.realtime.disconnect()
      await admin.from("post").delete().eq("slug", slug)
    }
  })

  test("UPDATE on post emits postgres_changes", async () => {
    const client = anonClient()
    const admin = adminClient()
    const slug = `rt-update-${Date.now()}`
    const events: RealtimePayload<Record<string, unknown>>[] = []

    const { data: inserted, error: insertError } = await admin
      .from("post")
      .insert({ title: "Before", slug })
    assert.ifError(insertError)
    const postId = stringColumn(inserted, "id")[0]
    assert.ok(postId)

    // Filtered to this row: api.test.ts runs beside this file and updates posts of its own, and the
    // first UPDATE to arrive was then sometimes that one ("Hello Integration (updated)").
    const channel = client.realtime
      .channel("public:post")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "post", filter: `id=eq.${postId}` },
        (payload) => events.push(payload),
      )

    try {
      await waitForSubscribe((cb) => channel.subscribe(cb))
      await sleep(300)

      const { error: updateError } = await admin
        .from("post")
        .update({ title: "After" })
        .eq("id", postId)
      assert.ifError(updateError)

      await waitForEvents(() => events.length, 1)
      assert.equal(events[0]?.eventType, "UPDATE")
      assert.equal(events[0]?.new?.["title"], "After")
    } finally {
      // An open socket keeps the test process alive, so a failed assertion must still close it.
      channel.unsubscribe()
      client.realtime.disconnect()
      await admin.from("post").delete().eq("id", postId)
    }
  })

  test("DELETE on post emits postgres_changes", async () => {
    const client = anonClient()
    const admin = adminClient()
    const slug = `rt-delete-${Date.now()}`
    const events: RealtimePayload<Record<string, unknown>>[] = []

    const { data: inserted, error: insertError } = await admin
      .from("post")
      .insert({ title: "To delete", slug })
    assert.ifError(insertError)
    const postId = stringColumn(inserted, "id")[0]
    assert.ok(postId)

    // Filtered to this row, for the same reason as the UPDATE test: api.test.ts deletes posts too.
    const channel = client.realtime
      .channel("public:post")
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "post", filter: `id=eq.${postId}` },
        (payload) => events.push(payload),
      )

    try {
      await waitForSubscribe((cb) => channel.subscribe(cb))
      await sleep(300)

      const { error: deleteError } = await admin.from("post").delete().eq("id", postId)
      assert.ifError(deleteError)

      await waitForEvents(() => events.length, 1)
      assert.equal(events[0]?.eventType, "DELETE")
      assert.equal(events[0]?.old?.["id"], postId)
    } finally {
      channel.unsubscribe()
      client.realtime.disconnect()
    }
  })

  test("column filter delivers only matching INSERT", async () => {
    const client = anonClient()
    const admin = adminClient()
    const matchSlug = `rt-filter-match-${Date.now()}`
    const otherSlug = `rt-filter-other-${Date.now()}`
    const events: RealtimePayload<Record<string, unknown>>[] = []

    const channel = client.realtime
      .channel("public:post")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "post",
          filter: `slug=eq.${matchSlug}`,
        },
        (payload) => events.push(payload),
      )

    try {
      await waitForSubscribe((cb) => channel.subscribe(cb))
      await sleep(300)

      const { error: otherError } = await admin
        .from("post")
        .insert({ title: "Other", slug: otherSlug })
      assert.ifError(otherError)

      await sleep(800)
      assert.equal(events.length, 0)

      const { error: matchError } = await admin
        .from("post")
        .insert({ title: "Match", slug: matchSlug })
      assert.ifError(matchError)

      await waitForEvents(() => events.length, 1)
      assert.equal(events[0]?.new?.["slug"], matchSlug)
    } finally {
      channel.unsubscribe()
      client.realtime.disconnect()
      await admin.from("post").delete().eq("slug", matchSlug)
      await admin.from("post").delete().eq("slug", otherSlug)
    }
  })
})

describe("realtime (F17 RLS)", () => {
  test("user A does not receive subscription events for user B", async () => {
    const admin = adminClient()
    const userA = await signUpTestUser("a")
    const userB = await signUpTestUser("b")

    const suffix = Date.now()
    const { error: authorAError } = await admin.from("author").insert({
      id: userA.userId,
      email: `author-a-${suffix}@example.com`,
      username: `author-a-${suffix}`,
      role: "user",
    })
    assert.ifError(authorAError)

    const { error: authorBError } = await admin.from("author").insert({
      id: userB.userId,
      email: `author-b-${suffix}@example.com`,
      username: `author-b-${suffix}`,
      role: "user",
    })
    assert.ifError(authorBError)

    const events: RealtimePayload<Record<string, unknown>>[] = []
    const realtimeA = userRealtimeClient(userA.accessToken)
    const channel = realtimeA
      .channel("public:subscription")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "subscription" },
        (payload) => events.push(payload),
      )

    const created: string[] = []
    try {
      await waitForSubscribe((cb) => channel.subscribe(cb))
      await sleep(400)

      const { data: subB, error: subBError } = await admin
        .from("subscription")
        .insert(newSubscriptionRow(userB.userId, String(Date.now())))
      assert.ifError(subBError)
      created.push(...stringColumn(subB, "id"))

      await waitForQuiet(() => events.length, 2000)

      const { data: subA, error: subAError } = await admin
        .from("subscription")
        .insert(newSubscriptionRow(userA.userId, String(Date.now() + 1)))
      assert.ifError(subAError)
      created.push(...stringColumn(subA, "id"))

      await waitForEvents(() => events.length, 1)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.new?.["subscriber_id"], userA.userId)
    } finally {
      channel.unsubscribe()
      realtimeA.disconnect()
      for (const id of created) await admin.from("subscription").delete().eq("id", id)
      await admin.from("author").delete().eq("id", userA.userId)
      await admin.from("author").delete().eq("id", userB.userId)
    }
  })
})

describe("realtime (presence & broadcast)", () => {
  test("broadcast and presence on a shared channel", async () => {
    const userA = await signUpTestUser("presence-a")
    const userB = await signUpTestUser("presence-b")
    const rtA = userRealtimeClient(userA.accessToken)
    const rtB = userRealtimeClient(userB.accessToken)
    const channelName = `room:integration-${Date.now()}`

    const broadcasts: Array<Record<string, unknown>> = []
    const presenceJoins: string[] = []

    const chA = rtA.channel(channelName)
    const chB = rtB
      .channel(channelName)
      .onBroadcast("ping", (payload) => broadcasts.push(payload))
      .onPresence((update) => {
        for (const join of update.joins) {
          presenceJoins.push(String(join["user_id"] ?? ""))
        }
      })

    try {
      await waitForSubscribe((cb) => chA.subscribe(cb))
      await waitForSubscribe((cb) => chB.subscribe(cb))
      await sleep(200)

      chA.track({ status: "online" })
      await waitForEvents(() => presenceJoins.length, 1, 5000)
      assert.ok(presenceJoins.includes(userA.userId))

      chA.broadcast("ping", { hello: "world" })
      await waitForEvents(() => broadcasts.length, 1, 5000)
      assert.equal(broadcasts[0]?.["hello"], "world")
    } finally {
      chA.unsubscribe()
      chB.unsubscribe()
      rtA.disconnect()
      rtB.disconnect()
    }
  })
})
