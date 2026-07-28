import { handleOptions, json } from "../_shared/cors.ts"

/** Echoes method, headers subset, and JSON body. */
export default async function handler(req: Request): Promise<Response> {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  let body: unknown = null
  if (req.method !== "GET" && req.method !== "HEAD") {
    const text = await req.text()
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = { raw: text }
      }
    }
  }

  return json({
    ok: true,
    function: "echo",
    method: req.method,
    contentType: req.headers.get("content-type"),
    authorizationPresent: Boolean(req.headers.get("authorization")),
    body,
  })
}
