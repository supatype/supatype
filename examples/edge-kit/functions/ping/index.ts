import { handleOptions, json } from "../_shared/cors.ts"

/** Minimal health check. */
export default async function handler(req: Request): Promise<Response> {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  return json({
    ok: true,
    function: "ping",
    method: req.method,
    at: new Date().toISOString(),
  })
}
