import type { Session, User } from "@supatype/client"

export function parseSessionFromCookies(
  cookies: Array<{ name: string; value: string }>,
  prefix: string = "sb",
): Session | null {
  const authCookie = cookies.find(
    (c) =>
      c.name === `${prefix}-auth-token` ||
      (c.name.startsWith(`${prefix}-`) && c.name.endsWith("-auth-token")),
  )
  if (authCookie === undefined) return null
  return parseSessionValue(authCookie.value)
}

function parseSessionValue(value: string): Session | null {
  try {
    return normalizeSession(JSON.parse(decodeURIComponent(value)) as unknown)
  } catch { /* not JSON */ }
  try {
    return normalizeSession(JSON.parse(Buffer.from(value, "base64").toString("utf-8")) as unknown)
  } catch { /* not base64 JSON */ }
  return null
}

function normalizeSession(raw: unknown): Session | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r["access_token"] !== "string") return null
  if (isJwtExpired(r["access_token"])) return null
  return {
    accessToken: r["access_token"],
    tokenType: typeof r["token_type"] === "string" ? r["token_type"] : "bearer",
    expiresIn: typeof r["expires_in"] === "number" ? r["expires_in"] : 3600,
    refreshToken: typeof r["refresh_token"] === "string" ? r["refresh_token"] : "",
    user: normalizeUser(
      typeof r["user"] === "object" && r["user"] !== null
        ? (r["user"] as Record<string, unknown>)
        : {},
    ),
    ...(typeof r["expires_at"] === "number" && { expiresAt: r["expires_at"] }),
  }
}

function isJwtExpired(token: string): boolean {
  const parts = token.split(".")
  if (parts.length !== 3) return true
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64").toString("utf-8"),
    ) as Record<string, unknown>
    const exp = typeof payload["exp"] === "number" ? payload["exp"] : null
    if (exp === null) return false
    return Date.now() / 1000 > exp
  } catch {
    return true
  }
}

function normalizeUser(raw: Record<string, unknown>): User {
  return {
    id: typeof raw["id"] === "string" ? raw["id"] : "",
    appMetadata: (raw["app_metadata"] ?? {}) as Record<string, unknown>,
    userMetadata: (raw["user_metadata"] ?? {}) as Record<string, unknown>,
    createdAt: typeof raw["created_at"] === "string" ? raw["created_at"] : "",
    updatedAt: typeof raw["updated_at"] === "string" ? raw["updated_at"] : "",
    ...(typeof raw["email"] === "string" && { email: raw["email"] }),
    ...(typeof raw["phone"] === "string" && { phone: raw["phone"] }),
    ...(typeof raw["role"] === "string" && { role: raw["role"] }),
  }
}
