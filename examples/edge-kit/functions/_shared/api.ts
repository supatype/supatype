/** Resolve API base URL for use from inside the functions worker. */

export function apiBaseUrl(): string {
  const raw = (
    Deno.env.get("SUPATYPE_INTERNAL_URL") ??
    Deno.env.get("SUPATYPE_URL") ??
    ""
  ).trim().replace(/\/$/, "")

  if (!raw) {
    throw new Error("SUPATYPE_URL is not set in the function runtime")
  }

  // Docker Compose wrongly used to inject the host gateway (localhost:18473).
  // From the worker container that is unreachable — use Kong on the compose network.
  try {
    const url = new URL(raw)
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return "http://kong:8000"
    }
  } catch {
    // fall through
  }

  return raw
}
