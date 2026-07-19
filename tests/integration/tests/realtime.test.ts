/**
 * Realtime integration — proxied WebSocket, WAL CDC, RLS, filters, presence/broadcast.
 *
 * Phase 10.6: F15 (CDC + latency), F17 (RLS isolation).
 */

import { strict as assert } from "node:assert"
import { test, describe, before } from "node:test"
import type { RealtimePayload } from "@supatype/client"
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
    const body = await res.json() as { status?: string }
    assert.equal(body.status, "ok")
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
    assert.equal((events[0]?.new as { slug?: string } | null)?.slug, slug)

    unsubscribe()
    client.realtime.disconnect()
    await admin.from("post").delete().eq("slug", slug)
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
    const postId = (inserted as Array<{ id: string }>)[0]?.id
    assert.ok(postId)

    const channel = client.realtime
      .channel("public:post")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "post" },
        (payload) => events.push(payload),
      )

    await waitForSubscribe((cb) => channel.subscribe(cb))
    await sleep(300)

    const { error: updateError } = await admin
      .from("post")
      .update({ title: "After" })
      .eq("id", postId)
    assert.ifError(updateError)

    await waitForEvents(() => events.length, 1)
    assert.equal(events[0]?.eventType, "UPDATE")
    assert.equal((events[0]?.new as { title?: string } | null)?.title, "After")

    channel.unsubscribe()
    client.realtime.disconnect()
    await admin.from("post").delete().eq("id", postId)
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
    const postId = (inserted as Array<{ id: string }>)[0]?.id
    assert.ok(postId)

    const channel = client.realtime
      .channel("public:post")
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "post" },
        (payload) => events.push(payload),
      )

    await waitForSubscribe((cb) => channel.subscribe(cb))
    await sleep(300)

    const { error: deleteError } = await admin.from("post").delete().eq("id", postId)
    assert.ifError(deleteError)

    await waitForEvents(() => events.length, 1)
    assert.equal(events[0]?.eventType, "DELETE")

    channel.unsubscribe()
    client.realtime.disconnect()
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
    assert.equal((events[0]?.new as { slug?: string } | null)?.slug, matchSlug)

    channel.unsubscribe()
    client.realtime.disconnect()
    await admin.from("post").delete().eq("slug", matchSlug)
    await admin.from("post").delete().eq("slug", otherSlug)
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

    await waitForSubscribe((cb) => channel.subscribe(cb))
    await sleep(400)

    const externalB = String(Date.now())
    const { data: subB, error: subBError } = await admin
      .from("subscription")
      .insert(newSubscriptionRow(userB.userId, externalB))
    assert.ifError(subBError)
    const subBId = (subB as Array<{ id: string }>)[0]?.id

    await waitForQuiet(() => events.length, 2000)

    const externalA = String(Date.now() + 1)
    const { data: subA, error: subAError } = await admin
      .from("subscription")
      .insert(newSubscriptionRow(userA.userId, externalA))
    assert.ifError(subAError)
    const subAId = (subA as Array<{ id: string }>)[0]?.id

    await waitForEvents(() => events.length, 1)
    assert.equal(events.length, 1)
    assert.equal((events[0]?.new as { subscriber_id?: string } | null)?.subscriber_id, userA.userId)

    channel.unsubscribe()
    realtimeA.disconnect()

    if (subAId) await admin.from("subscription").delete().eq("id", subAId)
    if (subBId) await admin.from("subscription").delete().eq("id", subBId)
    await admin.from("author").delete().eq("id", userA.userId)
    await admin.from("author").delete().eq("id", userB.userId)
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

    await waitForSubscribe((cb) => chA.subscribe(cb))
    await waitForSubscribe((cb) => chB.subscribe(cb))
    await sleep(200)

    chA.track({ status: "online" })
    await waitForEvents(() => presenceJoins.length, 1, 5000)
    assert.ok(presenceJoins.includes(userA.userId))

    chA.broadcast("ping", { hello: "world" })
    await waitForEvents(() => broadcasts.length, 1, 5000)
    assert.equal(broadcasts[0]?.["hello"], "world")

    chA.unsubscribe()
    chB.unsubscribe()
    rtA.disconnect()
    rtB.disconnect()
  })
})
