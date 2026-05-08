export default function envCheck(): Response {
  const denoEnv = (globalThis as { Deno?: { env?: { get: (key: string) => string | undefined } } }).Deno?.env

  return new Response(
    JSON.stringify({
      ok: true,
      function: "env-check",
      hasSupatypeUrl: Boolean(denoEnv?.get("SUPATYPE_URL")),
      hasAnonKey: Boolean(denoEnv?.get("SUPATYPE_ANON_KEY")),
      hasServiceRoleKey: Boolean(denoEnv?.get("SUPATYPE_SERVICE_ROLE_KEY")),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  )
}
