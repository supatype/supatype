/**
 * The surfaces a browser cannot assert, asserted headlessly.
 *
 * Playwright can see that a page rendered. It cannot tell a realtime socket that delivers from one
 * that merely opens, an access rule that filters from a query that happened to match nothing, or a
 * transform that resized from a CDN echoing the original. Each of those looks identical from the
 * outside until something waits for the difference, with a deadline, and exits non-zero.
 *
 *   pnpm dev       # in one terminal: Postgres, the schema, the stack
 *   pnpm seed
 *   pnpm verify    # in another
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createClient } from "@supatype/client"

const KONG_PORT = process.env["SUPATYPE_KONG_PORT"] ?? "18473"
const URL = process.env["SUPATYPE_URL"] ?? `http://127.0.0.1:${KONG_PORT}`
const DEADLINE_MS = Number(process.env["KITCHEN_SINK_DEADLINE_MS"] ?? 30_000)

function anonKey(): string {
  const fromEnv = process.env["SUPATYPE_ANON_KEY"] ?? process.env["ANON_KEY"]
  if (fromEnv) return fromEnv
  const env = readFileSync(resolve(import.meta.dirname, ".env"), "utf8")
  const match = env.match(/^ANON_KEY=(.*)$/m)
  if (!match) throw new Error("no ANON_KEY in .env — run `supatype dev` first")
  return match[1]!.trim().replace(/^"|"$/g, "")
}

const failures: string[] = []
function check(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`)
    failures.push(label)
  }
}

async function main(): Promise<void> {
  const key = anonKey()
  const anon = createClient({ url: URL, anonKey: key })

  console.log("==> the read rule is the filter")
  const { data: publicTalks, error: talkError } = await anon.from("talk").select()
  if (talkError) throw new Error(`reading talks as anon: ${talkError.message}`)
  const titles = (publicTalks ?? []).map((t) => (t as { title: string }).title)
  // The seed writes two talks and publishes one. Nothing here filters on `published_at`: if the
  // draft appears, the rule is not being enforced, which a query with a filter would have hidden.
  check(
    titles.includes("Schemas that refuse bad data"),
    "anon reads the published talk",
    `saw ${JSON.stringify(titles)}`,
  )
  check(
    !titles.includes("Unfinished thoughts on indexes"),
    "anon cannot read the unpublished talk",
    `saw ${JSON.stringify(titles)}`,
  )

  console.log("\n==> a signed-in caller")
  const email = `verify-${Date.now()}@example.com`
  const { error: signUpError } = await anon.auth.signUp({ email, password: "correct-horse-battery" })
  if (signUpError) throw new Error(`sign up: ${signUpError.message}`)
  check(true, `signed up ${email}`)

  console.log("\n==> realtime delivers a row, not just a socket")
  const body = `hello at ${new Date().toISOString()}`
  let status = "never reported"
  const arrived = new Promise<boolean>((resolveArrived) => {
    const sub = anon.from("chat_message").subscribe(
      (payload) => {
        if ((payload.new as { body?: string } | null)?.body === body) {
          sub.unsubscribe()
          resolveArrived(true)
        }
      },
      { event: "INSERT" },
    )
    sub.channel.subscribe((s) => { status = s })
    setTimeout(() => resolveArrived(false), DEADLINE_MS)
  })

  const subscribedBy = Date.now() + 15_000
  while (status !== "SUBSCRIBED" && Date.now() < subscribedBy) {
    await new Promise((r) => setTimeout(r, 100))
  }
  check(status === "SUBSCRIBED", "the channel subscribed", status)

  const { error: insertError } = await anon.from("chat_message").insert({ room: "lobby", body })
  if (insertError) throw new Error(`writing a chat message: ${insertError.message}`)
  check(await arrived, "the insert reached the subscriber", `within ${DEADLINE_MS}ms`)

  console.log("\n==> three refusals, in three different places")
  // All three must refuse. A write that succeeds here is the interesting failure: it means a rule
  // the schema states is not being enforced, which no amount of sending valid values would reveal.
  const refusals: [string, string][] = [
    ["a bound (MaxLength)", "x".repeat(600)],
    ["a model constraint (Length >= 2)", "x"],
    ["a validator (no shouting)", "HELLO EVERYONE"],
  ]
  for (const [what, body] of refusals) {
    const { error: refused } = await anon.from("chat_message").insert({ room: "lobby", body })
    check(refused !== null, `${what} refuses the write`, "the write was ACCEPTED")
  }

  console.log("\n==> realtime: what is not a row")
  // postgres_changes above carried what was written down. These carry what was not: presence is
  // who is here now, broadcast is a message with no database behind it. Both are separate paths
  // through the socket, and a stack with healthy replication can still fail them.
  const room = `lobby:verify-${Date.now()}`
  const rx = anon.realtime.channel(room)
  const gotBroadcast = new Promise<boolean>((res) => {
    rx.onBroadcast("typing", () => res(true))
    setTimeout(() => res(false), DEADLINE_MS)
  })
  const gotPresence = new Promise<boolean>((res) => {
    rx.onPresence((event) => { if (event.joins.length > 0) res(true) })
    setTimeout(() => res(false), DEADLINE_MS)
  })
  await new Promise<void>((res) => {
    rx.subscribe((s) => { if (s === "SUBSCRIBED") res() })
    setTimeout(res, 15_000)
  })
  rx.track({ who: "verify" })
  rx.broadcast("typing", { who: "verify" })
  check(await gotPresence, "a presence join is delivered", `within ${DEADLINE_MS}ms`)
  check(await gotBroadcast, "a broadcast is delivered", `within ${DEADLINE_MS}ms`)
  rx.unsubscribe()

  console.log("\n==> storage: upload, transform, remove")
  const bucket = anon.storage.from("speaker-headshots")
  const path = `verify/${Date.now()}.png`
  // A one-pixel PNG: the smallest thing the transformer can be asked to re-encode.
  const png = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
    (c) => c.charCodeAt(0),
  )
  const { error: uploadError } = await bucket.upload(path, new Blob([png], { type: "image/png" }), {
    contentType: "image/png",
    upsert: true,
  })
  check(uploadError === null, "uploaded to a bucket whose create rule is BucketLoggedIn", uploadError?.message)

  const plain = bucket.getPublicUrl(path).data.publicUrl
  const resized = bucket.getPublicUrl(path, {
    transform: { width: 16, height: 16, format: "webp" },
  }).data.publicUrl
  check(plain !== resized, "the transform produces a different URL", plain)

  const [plainRes, resizedRes] = await Promise.all([fetch(plain), fetch(resized)])
  check(plainRes.ok, "the object is served", String(plainRes.status))
  check(
    resizedRes.ok && resizedRes.headers.get("content-type") !== plainRes.headers.get("content-type"),
    "the transformed object is re-encoded, not echoed",
    `${plainRes.headers.get("content-type")} vs ${resizedRes.headers.get("content-type")}`,
  )

  const { error: removeError } = await bucket.remove([path])
  check(removeError === null, "removed it again", removeError?.message)

  console.log("\n==> a private bucket is private")
  // The public bucket above is reachable by URL alone. This one must not be: a public URL into
  // `ticket-files` is a 400 or 403 for everybody, and a signed URL is the only way in. Asserting
  // the refusal matters more than asserting the success — a bucket that reads as public would pass
  // every happy-path test ever written against it.
  const tickets = anon.storage.from("ticket-files")
  const privatePath = `verify/${Date.now()}.pdf`
  const { error: pdfUploadError } = await tickets.upload(
    privatePath,
    new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" }),
    { contentType: "application/pdf", upsert: true },
  )
  check(pdfUploadError === null, "a signed-in caller can write to the private bucket", pdfUploadError?.message)

  const publicAttempt = await fetch(tickets.getPublicUrl(privatePath).data.publicUrl)
  check(!publicAttempt.ok, "the public URL into a private bucket is refused", String(publicAttempt.status))

  const { data: signed, error: signError } = await tickets.createSignedUrl(privatePath, 60)
  check(signError === null && typeof signed?.signedUrl === "string", "a signed URL is minted", signError?.message)
  if (signed?.signedUrl) {
    const viaSigned = await fetch(signed.signedUrl)
    check(viaSigned.ok, "the signed URL reaches the object", String(viaSigned.status))
  }
  await tickets.remove([privatePath])

  console.log("\n==> the edge function answers")
  const ping = await fetch(`${URL}/functions/v1/ping`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  })
  check(ping.ok, "ping invoked", String(ping.status))

  // The gate, not the happy path: issue-ticket refuses an anon Bearer with a 401 rather than
  // writing a ticket owned by nobody. A function that wrote first and checked later would pass a
  // test that only looked for a 2xx.
  const anonIssue = await fetch(`${URL}/functions/v1/issue-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  })
  check(anonIssue.status === 401, "issue-ticket refuses an anon caller", String(anonIssue.status))

  console.log("")
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} of the checks above did not hold`)
    process.exit(1)
  }
  console.log("PASS: access rules, realtime delivery, storage round trip and functions")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
