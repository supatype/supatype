import type { Session, User } from "@supatype/client"

export function parseSessionFromCookies(
  cookies: Array<{ name: string; value: string }>,
  prefix: string = "st",
): Session | null {
  const candidates = cookies.filter(
    (c) =>
      c.name === `${prefix}-auth-token` ||
      (c.name.startsWith(`${prefix}-`) && c.name.endsWith("-auth-token")),
  )
  if (candidates.length === 0) return null

  // Prefer the canonical cookie name written by @supatype/client.
  candidates.sort((a, b) => {
    const aExact = a.name === `${prefix}-auth-token` ? 1 : 0
    const bExact = b.name === `${prefix}-auth-token` ? 1 : 0
    return bExact - aExact
  })

  for (const cookie of candidates) {
    const parsed = parseSessionValue(cookie.value)
    if (parsed !== null) return parsed
  }
  return null
}

/** True for a JSON object: not null, not an array. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseSessionValue(value: string): Session | null {
  try {
    return normalizeSession(JSON.parse(decodeURIComponent(value)))
  } catch { /* not JSON */ }
  try {
    return normalizeSession(JSON.parse(Buffer.from(value, "base64").toString("utf-8")))
  } catch { /* not base64 JSON */ }
  return null
}

function normalizeSession(r: unknown): Session | null {
  if (!isJsonObject(r)) return null
  if (typeof r["access_token"] !== "string") return null
  if (isJwtExpired(r["access_token"])) return null
  return {
    accessToken: r["access_token"],
    tokenType: typeof r["token_type"] === "string" ? r["token_type"] : "bearer",
    expiresIn: typeof r["expires_in"] === "number" ? r["expires_in"] : 3600,
    refreshToken: typeof r["refresh_token"] === "string" ? r["refresh_token"] : "",
    user: normalizeUser(isJsonObject(r["user"]) ? r["user"] : {}),
    ...(typeof r["expires_at"] === "number" && { expiresAt: r["expires_at"] }),
  }
}

function isJwtExpired(token: string): boolean {
  const parts = token.split(".")
  if (parts.length !== 3) return true
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64").toString("utf-8"))
    // A payload that is not an object reads as expired, as it did when reading it threw.
    if (!isJsonObject(payload)) return true
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
    appMetadata: isJsonObject(raw["app_metadata"]) ? raw["app_metadata"] : {},
    userMetadata: isJsonObject(raw["user_metadata"]) ? raw["user_metadata"] : {},
    createdAt: typeof raw["created_at"] === "string" ? raw["created_at"] : "",
    updatedAt: typeof raw["updated_at"] === "string" ? raw["updated_at"] : "",
    ...(typeof raw["email"] === "string" && { email: raw["email"] }),
    ...(typeof raw["phone"] === "string" && { phone: raw["phone"] }),
    ...(typeof raw["role"] === "string" && { role: raw["role"] }),
  }
}
