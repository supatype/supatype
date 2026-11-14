/**
 * Many-to-many links written through the link table, over the normal API.
 *
 * The junction of `lot` and `tag` is `lot_tag` (the two table names, sorted, joined by `_`), with
 * `lot_id` and `tag_id`. This signs in as real users and asserts what each of them can do to it.
 * Run by tests/integration/scripts/m2m-e2e.sh against a live stack.
 */
import { createClient } from "./supatype/generated/client"

const URL = process.env["SUPATYPE_URL"] ?? "http://127.0.0.1:18750"
const ANON = process.env["SUPATYPE_ANON_KEY"] ?? ""
const PASSWORD = "m2m-password-12345"
const run = Date.now().toString(36)

let failures = 0
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === "" ? "" : `: ${detail}`}`)
  if (!ok) failures += 1
}

function newClient() {
  return createClient({ url: URL, anonKey: ANON })
}
type Client = ReturnType<typeof newClient>

/** A signed-in user with a member row, so that `Owner<"owner_id">` on a lot means them. */
async function userWithMember(name: string): Promise<{ client: Client; id: string }> {
  const client = newClient()
  const email = `${name}-${run}@example.com`
  const up = await client.auth.signUp({ email, password: PASSWORD })
  if (up.error !== null) throw new Error(`sign up ${name}: ${up.error.message}`)
  const inn = await client.auth.signInWithPassword({ email, password: PASSWORD })
  const id = inn.data.user?.id
  if (inn.error !== null || id === undefined) throw new Error(`sign in ${name}: ${inn.error?.message ?? "no user"}`)
  const made = await client.from("member").insert({ id, name })
  if (made.error !== null) throw new Error(`member ${name}: ${made.error.message}`)
  return { client, id }
}

async function must<T>(label: string, p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const r = await p
  if (r.error !== null || r.data === null) throw new Error(`${label}: ${r.error?.message ?? "no data"}`)
  return r.data
}

async function main(): Promise<void> {
  const alice = await userWithMember("alice")
  const bob = await userWithMember("bob")
  const anon = newClient()

  const [lot] = await must("alice makes a lot", alice.client.from("lot").insert({ title: `vase ${run}`, owner_id: alice.id }).select("id"))
  const [tag] = await must("a tag", alice.client.from("tag").insert({ name: `antique-${run}` }).select("id"))
  if (lot === undefined || tag === undefined) throw new Error("no lot or tag row came back")

  console.log("==> the owner of a lot links it to a tag")
  const link = await alice.client.from("lot_tag").insert({ lot_id: lot.id, tag_id: tag.id })
  check("owner inserts a link", link.error === null, link.error?.message)
  const read = await alice.client.from("lot").select("id, title, tags:tag(name)").eq("id", lot.id)
  const names = (read.data?.[0]?.tags ?? []).map((t) => t.name)
  check("the lot reads back with the tag embedded", names.length === 1 && names[0] === `antique-${run}`, JSON.stringify(read.data))
  const reverse = await anon.from("tag").select("name, lots:lot(title)").eq("id", tag.id)
  check("the other end embeds the lot, for anon", reverse.data?.[0]?.lots?.[0]?.title === `vase ${run}`, JSON.stringify(reverse))

  console.log("==> someone who cannot update the lot cannot link it")
  const other = await must("a second tag", alice.client.from("tag").insert({ name: `rare-${run}` }).select("id"))
  const tag2 = other[0]
  if (tag2 === undefined) throw new Error("no second tag")
  const foreign = await bob.client.from("lot_tag").insert({ lot_id: lot.id, tag_id: tag2.id })
  check("bob cannot link alice's lot", foreign.error !== null, "the insert succeeded")
  const after = await anon.from("lot_tag").select("tag_id").eq("lot_id", lot.id)
  check("no link was written", after.data?.length === 1, JSON.stringify(after.data))

  console.log("==> anon cannot write a link")
  const anonInsert = await anon.from("lot_tag").insert({ lot_id: lot.id, tag_id: tag2.id })
  check("anon insert is refused", anonInsert.error !== null, "the insert succeeded")
  const anonDelete = await anon.from("lot_tag").delete().eq("lot_id", lot.id).eq("tag_id", tag.id).select()
  check("anon delete removes nothing", (anonDelete.data?.length ?? 0) === 0)
  const bobDelete = await bob.client.from("lot_tag").delete().eq("lot_id", lot.id).eq("tag_id", tag.id).select()
  check("bob delete removes nothing", (bobDelete.data?.length ?? 0) === 0)

  console.log("==> the owner removes a link")
  const gone = await alice.client.from("lot_tag").delete().eq("lot_id", lot.id).eq("tag_id", tag.id).select()
  check("owner delete removes the row", gone.error === null && gone.data?.length === 1, JSON.stringify(gone))
  const left = await anon.from("lot_tag").select("tag_id").eq("lot_id", lot.id)
  check("the link is gone", left.data?.length === 0, JSON.stringify(left.data))

  console.log("==> the model that declares the relation owns the link")
  const badge = await must("a badge", alice.client.from("badge").insert({ name: `mint-${run}` }).select("id"))
  const badgeId = badge[0]?.id
  if (badgeId === undefined) throw new Error("no badge row")
  const viaBadge = await bob.client.from("badge_lot").insert({ lot_id: lot.id, badge_id: badgeId })
  check("bob may update the badge but not the lot, so he cannot link them", viaBadge.error !== null, "the insert succeeded")
  const byOwner = await alice.client.from("badge_lot").insert({ lot_id: lot.id, badge_id: badgeId })
  check("the owner of the lot can attach that badge", byOwner.error === null, byOwner.error?.message)

  console.log("==> the generated types know the junction")
  // @ts-expect-error a table the schema does not have is a type error
  anon.from("lot_nope")
}

main().then(
  () => {
    if (failures > 0) {
      console.log(`FAILED: ${failures} check(s)`)
      process.exit(1)
    }
    console.log("PASS: link-table writes behave as documented")
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
