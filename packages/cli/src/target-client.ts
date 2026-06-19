export interface TargetFetchOptions {
  method: string
  path: string
  body?: unknown
  token: string
  orgId?: string | undefined
  environment?: string | undefined
}

export async function targetFetch<T>(
  baseUrl: string,
  apiPrefix: "/api/v1" | "/platform/v1",
  opts: TargetFetchOptions,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.token}`,
  }
  if (opts.orgId) headers["X-Org-Id"] = opts.orgId
  if (opts.environment) headers["X-Supatype-Environment"] = opts.environment

  const url = `${baseUrl.replace(/\/$/, "")}${apiPrefix}${opts.path}`
  const res = await fetch(url, {
    method: opts.method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })

  const json = (await res.json().catch(() => ({}))) as {
    data?: T
    error?: string
    message?: string
  }

  if (!res.ok) {
    throw new Error(json.message ?? json.error ?? `API error: ${res.status} ${url}`)
  }

  return (json.data !== undefined ? json.data : json) as T
}
