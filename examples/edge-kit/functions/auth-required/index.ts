import { handleOptions, json } from "../_shared/cors.ts"

/**
 * Requires a Bearer token that is not the project anon key.
 * Use the UI "with session" path (sign-up) or pass a user JWT.
 */
export default async function handler(req: Request): Promise<Response> {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  const auth = req.headers.get("authorization") ?? ""
  const match = /^Bearer\s+(.+)$/i.exec(auth)
  if (!match) {
    return json(
      { error: "unauthorized", message: "Missing Bearer token" },
      401,
    )
  }

  const token = match[1]!.trim()
  const anon = Deno.env.get("SUPATYPE_ANON_KEY")
  if (anon !== undefined && anon.length > 0 && token === anon) {
    return json(
      {
        error: "unauthorized",
        message: "Anon key is not enough — sign in (or sign up) so invoke sends a user JWT",
      },
      401,
    )
  }

  return json({
    ok: true,
    function: "auth-required",
    message: "Bearer accepted (not anon key)",
  })
}
