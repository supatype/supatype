export default async function echo(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null)

  return new Response(
    JSON.stringify({
      ok: true,
      function: "echo",
      body,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  )
}
