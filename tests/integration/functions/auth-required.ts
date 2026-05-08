export default function authRequired(req: Request): Response {
  const authHeader = req.headers.get("authorization")
  const hasBearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ")

  if (!hasBearer) {
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        message: "Missing Bearer token",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  return new Response(
    JSON.stringify({
      ok: true,
      function: "auth-required",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  )
}
