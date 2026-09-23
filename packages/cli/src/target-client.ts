export interface TargetFetchOptions {
  method: string
  path: string
  body?: unknown
  token: string
  orgId?: string | undefined
  environment?: string | undefined
  /**
   * Cloud-only: renew short-lived access JWT via control-plane `/auth/refresh`.
   * Self-host SERVICE_ROLE_KEY links omit this.
   */
  authRefresh?: {
    cloudApiUrl: string
    refreshToken: string
    onRefreshed: (tokens: { accessToken: string; refreshToken?: string }) => void
  }
}

export class TargetApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = "TargetApiError"
    this.status = status
    if (code !== undefined) this.code = code
  }
}

function isAuthExpiry(status: number, code?: string, message?: string): boolean {
  if (status !== 401) return false
  if (code === "TOKEN_EXPIRED" || code === "NO_SESSION" || code === "INVALID_TOKEN") return true
  const m = (message ?? "").toLowerCase()
  return m.includes("token expired") || m.includes("authentication required")
}

async function refreshAccessToken(
  authRefresh: NonNullable<TargetFetchOptions["authRefresh"]>,
): Promise<string> {
  const base = authRefresh.cloudApiUrl.replace(/\/$/, "")
  const res = await fetch(`${base}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: authRefresh.refreshToken }),
  })
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    message?: string
    error?: string
  }
  if (!res.ok || !json.access_token) {
    throw new Error(
      `${json.message ?? json.error ?? "Token refresh failed"}. Run: supatype login`,
    )
  }
  authRefresh.onRefreshed({
    accessToken: json.access_token,
    ...(json.refresh_token !== undefined ? { refreshToken: json.refresh_token } : {}),
  })
  return json.access_token
}

export async function targetFetch<T>(
  baseUrl: string,
  apiPrefix: "/api/v1" | "/platform/v1",
  opts: TargetFetchOptions,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}${apiPrefix}${opts.path}`

  const doFetch = async (token: string): Promise<{
    ok: boolean
    status: number
    json: { data?: T; error?: string; message?: string; code?: string }
  }> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }
    if (opts.orgId) headers["X-Org-Id"] = opts.orgId
    if (opts.environment) headers["X-Supatype-Environment"] = opts.environment

    const res = await fetch(url, {
      method: opts.method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })

    const json = (await res.json().catch(() => ({}))) as {
      data?: T
      error?: string
      message?: string
      code?: string
    }
    return { ok: res.ok, status: res.status, json }
  }

  let token = opts.token
  let result = await doFetch(token)

  if (
    !result.ok &&
    opts.authRefresh &&
    isAuthExpiry(result.status, result.json.code, result.json.message ?? result.json.error)
  ) {
    token = await refreshAccessToken(opts.authRefresh)
    result = await doFetch(token)
  }

  if (!result.ok) {
    const message = result.json.message ?? result.json.error ?? `API error: ${result.status} ${url}`
    if (
      isAuthExpiry(result.status, result.json.code, message) &&
      !opts.authRefresh
    ) {
      throw new TargetApiError(
        `${message}. Session expired, run: supatype login`,
        result.status,
        result.json.code,
      )
    }
    throw new TargetApiError(message, result.status, result.json.code)
  }

  return (result.json.data !== undefined ? result.json.data : result.json) as T
}
