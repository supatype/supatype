/**
 * Phase 1 of the SeaweedFS migration: prove the S3 surface `packages/storage` actually uses.
 *
 * This drives the shipped functions from `packages/storage/dist/s3.js` rather than hand-written
 * requests, because the thing under test is whether *our code* works against the backend, not
 * whether the backend is broadly S3-shaped. A hand-rolled request can be quietly adjusted until it
 * passes; an exported function cannot.
 *
 * The decisive assertion is the public/private pair. `applyPublicPolicy` is the one call with no
 * `try/catch` around it and no fallback, and a backend that accepts the policy document but does
 * not enforce it would leave every private bucket readable. So the public read is asserted
 * *and* the same read against a bucket with no policy is asserted to fail. One without the other
 * proves nothing.
 *
 * Usage (env set by storage-backend-e2e.sh):
 *   S3_ENDPOINT=http://localhost:8333 npx tsx scripts/storage-backend.ts
 */
import { randomBytes } from "node:crypto"

process.env.JWT_SECRET ??= "integration-secret-at-least-32-characters-long"
process.env.S3_ENDPOINT ??= "http://localhost:8333"
process.env.S3_PUBLIC_URL ??= process.env.S3_ENDPOINT
process.env.S3_ACCESS_KEY ??= "supatype"
process.env.S3_SECRET_KEY ??= "supatype-secret"
process.env.S3_FORCE_PATH_STYLE ??= "true"

// Imported after the env above: packages/storage/src/env.ts evaluates its config at module load
// and throws on a missing JWT_SECRET, so a static import would fail before this file runs.
const s3 = await import("../../../packages/storage/dist/s3.js")

const BACKEND = process.env.STORAGE_BACKEND_NAME ?? "the backend"
const suffix = randomBytes(4).toString("hex")
const publicBucket = `phase1-public-${suffix}`
const privateBucket = `phase1-private-${suffix}`

let failures = 0

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  ok    ${name}`)
    return
  }
  console.error(`  FAIL  ${name}: ${detail}`)
  failures += 1
}

/** Fetch with no credentials at all, which is what a browser hitting a public URL sends. */
async function anonymousStatus(url: string): Promise<number> {
  const res = await fetch(url, { redirect: "manual" })
  return res.status
}

async function bucketLifecycle(): Promise<void> {
  console.log("==> buckets")
  await s3.ensureBucket(publicBucket)
  // Twice on purpose: the second call takes the HeadBucket success branch, which is the half that
  // never runs on a fresh backend and the half that breaks if HeadBucket reports absence wrongly.
  await s3.ensureBucket(publicBucket)
  await s3.ensureBucket(privateBucket)
  check("ensureBucket is idempotent", true, "")
}

async function objectRoundTrip(): Promise<void> {
  console.log("==> objects")
  const body = randomBytes(2048)
  await s3.putObject(publicBucket, "round/trip.bin", body, "application/octet-stream")

  const got = await s3.getObject(publicBucket, "round/trip.bin")
  check("getObject returns the bytes put", got.body.equals(body), `${got.body.length} bytes back`)

  const head = await s3.headObject(publicBucket, "round/trip.bin")
  check(
    "headObject reports the length",
    head.contentLength === body.length,
    `reported ${head.contentLength}, wrote ${body.length}`,
  )
}

async function listing(): Promise<void> {
  console.log("==> listing")
  for (const n of [0, 1, 2]) {
    await s3.putObject(publicBucket, `list/item-${n}.txt`, Buffer.from(`item ${n}`), "text/plain")
  }
  const all = await s3.listObjects(publicBucket, "list/", 10, 0)
  check("listObjects finds the prefix", all.length === 3, `got ${all.length} keys, expected 3`)

  // listObjects asks for `limit + offset` keys and slices locally, so a backend that caps MaxKeys
  // differently drops rows silently rather than erroring.
  const offset = await s3.listObjects(publicBucket, "list/", 2, 1)
  check("listObjects honours the offset", offset.length === 2, `got ${offset.length}, expected 2`)
}

async function presigned(): Promise<void> {
  console.log("==> presigned URLs")
  const downloadUrl = await s3.createSignedDownloadUrl(publicBucket, "round/trip.bin", 300)
  const downloaded = await fetch(downloadUrl)
  check("presigned GET is served", downloaded.status === 200, `answered ${downloaded.status}`)

  const uploadUrl = await s3.createSignedUploadUrl(publicBucket, "signed/up.txt", 300, "text/plain")
  const uploaded = await fetch(uploadUrl, {
    method: "PUT",
    body: "signed upload",
    headers: { "content-type": "text/plain" },
  })
  // The body, not just the code: a refused upload says why, and "400" on its own sent me looking
  // at the signature when the server was objecting to something else entirely.
  const refusal = uploaded.ok ? "" : ` said ${JSON.stringify((await uploaded.text()).slice(0, 300))}`
  check("presigned PUT is accepted", uploaded.ok, `answered ${uploaded.status}${refusal}`)

  if (uploaded.ok) {
    const back = await s3.getObject(publicBucket, "signed/up.txt")
    check(
      "presigned PUT stored the body",
      back.body.toString() === "signed upload",
      `read back ${JSON.stringify(back.body.toString())}`,
    )
  }
}

/**
 * The reason this whole phase exists. Both halves, or neither counts.
 */
async function publicAndPrivate(): Promise<void> {
  console.log("==> public policy, and its control")
  await s3.putObject(publicBucket, "open.txt", Buffer.from("public"), "text/plain")
  await s3.putObject(privateBucket, "closed.txt", Buffer.from("private"), "text/plain")

  await s3.applyPublicPolicy(publicBucket)

  const openStatus = await anonymousStatus(s3.publicObjectUrl(publicBucket, "open.txt"))
  check("an anonymous read of a public bucket succeeds", openStatus === 200, `answered ${openStatus}`)

  const closedStatus = await anonymousStatus(s3.publicObjectUrl(privateBucket, "closed.txt"))
  check(
    "an anonymous read of a bucket with no policy is refused",
    closedStatus !== 200,
    `answered 200, so ${BACKEND} accepted the policy without enforcing the absence of one`,
  )
}

async function rawPolicy(): Promise<void> {
  console.log("==> caller-supplied policy")
  const doc = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicReadGetObject",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${privateBucket}/*`,
      },
    ],
  })
  await s3.applyRawBucketPolicy(privateBucket, doc)
  const status = await anonymousStatus(s3.publicObjectUrl(privateBucket, "closed.txt"))
  check("a raw policy is applied and enforced", status === 200, `answered ${status}`)
}

async function deletion(): Promise<void> {
  console.log("==> deletion")
  // One key that exists and one that does not: batch delete reports partial failure differently
  // between implementations, and our caller ignores the response entirely.
  await s3.deleteObjects(publicBucket, ["list/item-0.txt", "list/never-existed.txt"])
  const left = await s3.listObjects(publicBucket, "list/", 10, 0)
  check(
    "deleteObjects removes the key that existed",
    !left.some((o) => o.key === "list/item-0.txt"),
    "the key survived the batch delete",
  )

  await s3.deleteObject(publicBucket, "open.txt")
  let gone = false
  try {
    await s3.headObject(publicBucket, "open.txt")
  } catch {
    gone = true
  }
  check("deleteObject removes a single key", gone, "headObject still finds the deleted key")
}

/**
 * A throw is a failure, not a reason to stop. The first run of this file died on the first
 * unsupported call and reported nothing about the seven assertions behind it, which is how a
 * compatibility matrix ends up with one known cell and ten unknown ones.
 */
async function section(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    check(`${name} completed`, false, message)
  }
}

async function main(): Promise<void> {
  console.log(`Storage backend compatibility: ${BACKEND} at ${process.env.S3_ENDPOINT}`)
  await section("buckets", bucketLifecycle)
  await section("objects", objectRoundTrip)
  await section("listing", listing)
  await section("presigned URLs", presigned)
  await section("public policy", publicAndPrivate)
  await section("caller-supplied policy", rawPolicy)
  await section("deletion", deletion)

  console.log("")
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed against ${BACKEND}`)
    process.exit(1)
  }
  console.log(`All assertions passed against ${BACKEND}`)
}

await main()
