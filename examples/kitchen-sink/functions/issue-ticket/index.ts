import type { FunctionContext } from "../_shared/context.ts"

/**
 * Issue the caller a ticket: auth-gated, then a write the caller could not make themselves.
 *
 * Two halves worth separating. The gate is the caller's own token — a missing or anonymous Bearer
 * is refused here rather than by a policy, because the answer is 401, not an empty list. The write
 * then runs with the service role, which is the point: `Ticket.reference` is unique and the price
 * is not the buyer's to choose, so issuing is server work even though reading is the owner's.
 *
 * The service-role key arrives in the context, not the environment: two concurrent calls sharing a
 * process must not see each other's credentials.
 */
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
  const user = (await who.json()) as { id?: string }
  if (typeof user.id !== "string") return json({ error: "That session names no user." }, 401)

  const reference = `KS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
  const created = await fetch(`${ctx.url}/rest/v1/ticket`, {
    method: "POST",
    headers: {
      apikey: ctx.serviceRoleKey,
      Authorization: `Bearer ${ctx.serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      auth_user_id: user.id,
      attendee_id: user.id,
      reference,
      price: { amount: "0.00", code: "GBP" },
      vatRate: "20.00",
    }),
  })

  if (!created.ok) {
    return json({ error: await created.text() }, created.status)
  }

  return json({ reference }, 201)
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
