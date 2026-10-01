/**
 * Storage as a project uses it, rather than as S3 sees it.
 *
 * `storage-backend.ts` drives `packages/storage` straight at the object store, which proves
 * SeaweedFS behaves. It never goes through the gateway, never carries a session, and never touches
 * the access rules a bucket declares, so none of what a self-hosted project depends on was covered:
 * whether an anon caller is refused from a private bucket, whether a signed-in one is allowed, and
 * whether the reference an upload produces can be stored in a column and read back.
 *
 * That last is the gap worth naming. `ImageAsset<avatars>` columns exist, the generator emits a
 * type for them, and nothing in this repository had ever written one, which is exactly why three
 * different definitions of the shape had drifted apart without anyone noticing.
 */
const BASE = process.env["SUPATYPE_URL"] ?? "http://127.0.0.1:18473"
const ANON = process.env["ANON_KEY"] ?? ""
const SERVICE = process.env["SERVICE_ROLE_KEY"] ?? ""
if (!ANON || !SERVICE) throw new Error("ANON_KEY and SERVICE_ROLE_KEY must be set")

let failures = 0
const ok = (m: string): void => console.log(`  ok   ${m}`)
const bad = (m: string, detail = ""): void => {
  failures++
  console.error(`  FAIL ${m}${detail ? ` - ${detail}` : ""}`)
}
const check = (cond: boolean, m: string, detail = ""): void => (cond ? ok(m) : bad(m, detail))

type Sent = { status: number; text: string; json: unknown }

async function send(
  path: string,
  init: { method?: string; body?: BodyInit; token?: string; type?: string; headers?: Record<string, string> } = {},
): Promise<Sent> {
  const headers: Record<string, string> = {
    apikey: ANON,
    Authorization: `Bearer ${init.token ?? ANON}`,
    ...init.headers,
  }
  if (init.type !== undefined) headers["Content-Type"] = init.type
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: res.status, text, json }
}

async function signUp(): Promise<{ token: string; id: string }> {
  const email = `storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`
  const res = await send("/auth/v1/signup", {
    method: "POST",
    type: "application/json",
    body: JSON.stringify({ email, password: "Correct-Horse-7" }),
  })
  const body = res.json as { access_token?: string; user?: { id?: string } }
  if (typeof body?.access_token !== "string" || typeof body.user?.id !== "string") {
    throw new Error(`signup failed (${res.status}): ${res.text.slice(0, 160)}`)
  }
  return { token: body.access_token, id: body.user.id }
}

/** Upload through the storage API, the way an application does. */
async function upload(
  bucket: string,
  path: string,
  body: string,
  token: string,
  opts: { type?: string; upsert?: boolean } = {},
): Promise<Sent> {
  return send(`/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    token,
    type: opts.type ?? "text/plain",
    body,
    ...(opts.upsert === true && { headers: { "x-upsert": "true" } }),
  })
}

async function removeObjects(bucket: string, paths: string[], token: string): Promise<Sent> {
  return send(`/storage/v1/object/${bucket}`, {
    method: "DELETE",
    token,
    type: "application/json",
    body: JSON.stringify({ prefixes: paths }),
  })
}

/** The public URL's bytes, with no session at all. */
async function publicBytes(bucket: string, path: string): Promise<string> {
  return (await fetch(`${BASE}/storage/v1/object/public/${bucket}/${path}`)).text()
}

async function publicBucket(): Promise<void> {
  console.log("-- a public bucket, through the gateway")
  const user = await signUp()
  const path = `probe/${Date.now()}.txt`
  const body = `hello ${Date.now()}`

  const put = await upload("avatars", path, body, user.token)
  check(put.status < 300, "a signed-in user uploads to a public bucket", `HTTP ${put.status}: ${put.text.slice(0, 120)}`)

  const back = await send(`/storage/v1/object/authenticated/avatars/${path}`, { token: user.token })
  check(back.status < 300 && back.text === body, "and downloads the same bytes", `HTTP ${back.status}`)

  // The URL an application hands to a browser or a crawler, which carries no session at all.
  const anonRead = await fetch(`${BASE}/storage/v1/object/public/avatars/${path}`)
  check(anonRead.status < 300, "the public URL is readable with no credentials", `HTTP ${anonRead.status}`)
  check((await anonRead.text()) === body, "and returns the same bytes")

  // supatype#81: the anon key is a JWT, and any JWT used to be enough to upload.
  const asAnon = await upload("avatars", `probe/anon-${Date.now()}.txt`, "anon", ANON)
  check(asAnon.status === 401, "the anon key is refused where create is BucketLoggedIn", `HTTP ${asAnon.status}`)

  // supatype#82, and its overwrite twin: another signed-in user may neither remove nor replace it.
  const stranger = await signUp()
  const theirDelete = await removeObjects("avatars", [path], stranger.token)
  check(
    theirDelete.status < 300 && Array.isArray(theirDelete.json) && theirDelete.json.length === 0,
    "another user's delete removes nothing where delete is BucketOwner",
    `HTTP ${theirDelete.status}: ${theirDelete.text.slice(0, 120)}`,
  )
  const theirOverwrite = await upload("avatars", path, "replaced", stranger.token, { upsert: true })
  check(theirOverwrite.status === 403, "and their overwrite is refused where update is BucketOwner", `HTTP ${theirOverwrite.status}`)
  check((await publicBytes("avatars", path)) === body, "so the object still holds the uploader's bytes")

  const ownDelete = await removeObjects("avatars", [path], user.token)
  check(
    Array.isArray(ownDelete.json) && ownDelete.json.length === 1,
    "the uploader deletes their own object",
    `HTTP ${ownDelete.status}: ${ownDelete.text.slice(0, 120)}`,
  )
}

async function privateBucket(): Promise<void> {
  console.log("-- a private bucket, and the rules it declares")
  const user = await signUp()
  const path = `probe/${Date.now()}.txt`

  const put = await upload("post-attachments", path, "secret", user.token)
  check(
    put.status < 300,
    "a signed-in user uploads where the rule is BucketLoggedIn",
    `HTTP ${put.status}: ${put.text.slice(0, 120)}`,
  )

  // The control: the object exists, so a refusal below is a refusal rather than a miss.
  const owner = await send(`/storage/v1/object/authenticated/post-attachments/${path}`, {
    token: user.token,
  })
  check(owner.status < 300, "the uploader reads it back")

  const anon = await fetch(`${BASE}/storage/v1/object/public/post-attachments/${path}`, {
    headers: { apikey: ANON },
  })
  check(anon.status >= 400, "an anon caller is refused", `HTTP ${anon.status}`)

  const stranger = await signUp()
  const other = await send(`/storage/v1/object/authenticated/post-attachments/${path}`, {
    token: stranger.token,
  })
  check(
    other.status < 300,
    "another signed-in user may read it, because the rule says logged in and not owner",
    `HTTP ${other.status}`,
  )

  const signed = await send(`/storage/v1/object/sign/post-attachments/${path}`, {
    method: "POST",
    token: user.token,
    type: "application/json",
    body: JSON.stringify({ expiresIn: 60 }),
  })
  const url = (signed.json as { signedURL?: string } | null)?.signedURL
  check(typeof url === "string", "a signed URL is issued", `HTTP ${signed.status}`)
  if (typeof url === "string") {
    const viaSigned = await fetch(url.startsWith("http") ? url : `${BASE}/storage/v1${url}`)
    check(viaSigned.status < 300, "and it reads without a session", `HTTP ${viaSigned.status}`)
  }
}

async function roleGatedBucket(): Promise<void> {
  console.log("-- a bucket only the service role may touch")
  const user = await signUp()
  const path = `probe/${Date.now()}.pdf`

  // With the type the bucket accepts, so the refusal is the rule's. Sent as text/plain, this was
  // refused with 415 for the content type, and passed while any signed-in user could upload here.
  const asUser = await upload("product-manuals", path, "%PDF-1.4", user.token, { type: "application/pdf" })
  check(asUser.status === 403, "a signed-in user is refused by the role rule", `HTTP ${asUser.status}`)

  const wrongType = await upload("product-manuals", path, "not a pdf", SERVICE)
  check(
    wrongType.status === 415,
    "a content type the bucket does not accept is refused, even for the service role",
    `HTTP ${wrongType.status}`,
  )

  const asService = await send(`/storage/v1/object/product-manuals/${path}`, {
    method: "POST",
    token: SERVICE,
    type: "application/pdf",
    body: "%PDF-1.4",
  })
  check(
    asService.status < 300,
    "the service role is allowed with the accepted type",
    `HTTP ${asService.status}: ${asService.text.slice(0, 120)}`,
  )
}

async function assetColumn(): Promise<void> {
  console.log("-- an asset column, which nothing had ever written")
  const user = await signUp()
  const path = `avatar/${Date.now()}.txt`
  const body = `avatar ${Date.now()}`

  const put = await upload("avatars", path, body, user.token)
  if (put.status >= 300) {
    bad("could not upload the avatar", `HTTP ${put.status}`)
    return
  }

  // The shape the generator now emits for an `ImageAsset` column: what `upload()` produced, and
  // the bucket it went to. No url, because a stored one goes stale and hard-codes the host.
  const reference = { bucket: "avatars", path }
  const created = await send("/rest/v1/author", {
    method: "POST",
    token: SERVICE,
    type: "application/json",
    body: JSON.stringify({
      id: user.id,
      email: `asset-${user.id.slice(0, 8)}@example.test`,
      username: `a${user.id.slice(0, 8)}`,
      role: "user",
      avatarUrl: reference,
    }),
  })
  check(created.status < 300, "a storage reference is accepted into an asset column", `HTTP ${created.status}: ${created.text.slice(0, 160)}`)

  const read = await send(`/rest/v1/author?id=eq.${user.id}&select=avatarUrl`)
  const rows = (read.json as { avatarUrl?: { bucket?: string; path?: string } }[] | null) ?? []
  const stored = rows[0]?.avatarUrl
  check(
    stored?.bucket === reference.bucket && stored?.path === reference.path,
    "and reads back as the same bucket and path",
    `got ${JSON.stringify(stored)}`,
  )

  // The whole point of storing a reference rather than a URL: the URL is derivable from it.
  if (stored?.bucket !== undefined && stored.path !== undefined) {
    const derived = `${BASE}/storage/v1/object/public/${stored.bucket}/${stored.path}`
    const fetched = await fetch(derived)
    check(fetched.status < 300, "and the URL derived from it serves the object", `HTTP ${fetched.status}`)
    check((await fetched.text()) === body, "with the bytes that were uploaded")
  }
}

async function main(): Promise<void> {
  await publicBucket()
  console.log("")
  await privateBucket()
  console.log("")
  await roleGatedBucket()
  console.log("")
  await assetColumn()
  console.log("")

  if (failures > 0) {
    console.error(`FAILED: ${failures} assertion(s)`)
    process.exit(1)
  }
  console.log("PASSED: storage works through the gateway, honours bucket rules, and round trips an asset column")
  process.exit(0)
}

void main()
