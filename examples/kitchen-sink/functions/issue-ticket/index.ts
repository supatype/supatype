import type { FunctionContext } from "../_shared/context.ts"

/**
 * Issue the caller a ticket: auth-gated, then a write the caller could not make themselves.
 *
 * Two halves worth separating. The gate is the caller's own token: a missing or anonymous Bearer
 * is refused here rather than by a policy, because the answer is 401, not an empty list. The write
 * then runs with the service role, which is the point: `Ticket.reference` is unique and the price
 * is not the buyer's to choose, so issuing is server work even though reading is the owner's.
 *
 * A ticket points at the caller's attendee row, and nothing else creates one: a new account, from
 * a password sign-up or a provider, has none yet. So the function makes it first, named from the
 * account, and leaves an existing row as it is.
 *
 * The service-role key arrives in the context, not the environment: two concurrent calls sharing a
 * process must not see each other's credentials.
 */
type Caller = { id?: string; email?: string; user_metadata?: { full_name?: string; name?: string } }

export default async function handler(req: Request, ctx: FunctionContext): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : ""

  if (token === "" || token === ctx.anonKey) {
    return json({ error: "Sign in to claim a ticket." }, 401)
  }

  if (ctx.serviceRoleKey === undefined) {
    // Refuse rather than fall back to the anon key: a write that silently ran as the wrong
    // principal is worse than one that did not run.
    return json({ error: "This route was not granted the service role." }, 500)
  }

  // Who the caller is, as the API sees them. Decoding the JWT here would trust a token nobody
  // verified; asking the auth service is the same check every other route makes.
  const who = await fetch(`${ctx.url}/auth/v1/user`, {
    headers: { apikey: ctx.anonKey, Authorization: `Bearer ${token}` },
  })
  if (!who.ok) return json({ error: "That session is not valid." }, 401)
  const user = (await who.json()) as Caller
  if (typeof user.id !== "string") return json({ error: "That session names no user." }, 401)

  const attendee = await ensureAttendee(ctx, user.id, displayName(user))
  if (!attendee.ok) return json({ error: await attendee.text() }, attendee.status)

  const reference = `KS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
  const created = await asServer(ctx, "ticket", "return=representation", {
    auth_user_id: user.id,
    attendee_id: user.id,
    reference,
    price: { amount: "0.00", code: "GBP" },
    vatRate: "20.00",
  })

  if (!created.ok) {
    return json({ error: await created.text() }, created.status)
  }

  return json({ reference }, 201)
}

/** The caller's attendee row, created if missing; an existing one keeps its name. */
function ensureAttendee(ctx: FunctionContext, id: string, name: string): Promise<Response> {
  return asServer(ctx, "attendee?on_conflict=id", "resolution=ignore-duplicates,return=minimal", {
    id,
    displayName: name,
  })
}

/** The provider's name for the account, else the email's local part. */
function displayName(user: Caller): string {
  const named = user.user_metadata?.full_name ?? user.user_metadata?.name
  const fallback = (user.email ?? "attendee").split("@")[0] ?? "attendee"
  return (named !== undefined && named.trim() !== "" ? named : fallback).slice(0, 80)
}

function asServer(ctx: FunctionContext, path: string, prefer: string, body: unknown): Promise<Response> {
  const key = ctx.serviceRoleKey ?? ""
  return fetch(`${ctx.url}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  })
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
