export default function ping(req: Request): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      function: "ping",
      method: req.method,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  )
}
