import { currentCall, type InboundCall } from "./invocation.ts"

/** The hook-depth header a hook's calls back into the stack carry. */
export const HOOK_DEPTH_HEADER = "x-supatype-hook-depth"

/** The end user's address, and the proof it comes from the project's own components (D14 option 2b). */
export const FORWARDED_FOR_HEADER = "St-Forwarded-For"
export const FORWARDING_SECRET_HEADER = "St-Forwarding-Secret"

const MAX_REDIRECTS = 20
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * The end user's address for a call this worker is serving: the `St-Forwarded-For` the server's proxy
 * or hook dispatch set, else the `X-Real-IP` the gateway wrote. The first value of either, or null.
 */
export function endUserAddress(headers: Headers): string | null {
  for (const name of [FORWARDED_FOR_HEADER, "x-real-ip"]) {
    const first = headers.get(name)?.split(",")[0]?.trim()
    if (first) return first
  }
  return null
}

export interface StackFetchOptions {
  /** The stack's own origin, or null when this worker was not told how to reach it. Read per call. */
  origin(): string | null
  /** The forwarding secret, "" when the project has none. Held here, never in the environment. */
  forwardingSecret: string
}

/** The origin of `url`, or null when it is not an absolute URL. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** What a call to the stack carries for the invocation making it. */
function addStackHeaders(headers: Headers, call: InboundCall, secret: string): void {
  if (call.hookDepth !== null) headers.set(HOOK_DEPTH_HEADER, call.hookDepth)
  if (secret !== "" && call.clientAddress !== null) {
    headers.set(FORWARDED_FOR_HEADER, call.clientAddress)
    headers.set(FORWARDING_SECRET_HEADER, secret)
  }
}

/** Whether a call from `call` has anything to add to a request to the stack. */
function hasStackHeaders(call: InboundCall, secret: string): boolean {
  return call.hookDepth !== null || (secret !== "" && call.clientAddress !== null)
}

/**
 * Carry the hook-depth header, the end user's address and the forwarding secret onto calls a function
 * or hook makes back into the stack, and onto those calls only.
 *
 * Patched once, at startup, with no per-call state of its own: what a call carries comes from the
 * invocation store, so concurrent invocations cannot see each other's.
 *
 * "The stack" is an exact origin match, not a prefix: `http://kong:8000.example.com` starts with
 * `http://kong:8000` and is somebody else's host. And a redirect is followed here, a hop at a time,
 * rather than by `fetch`: a stack endpoint can redirect to another origin (a storage download goes
 * to a signed URL), and `fetch` keeps custom headers across origins, which would hand the secret to
 * whoever the stack redirects to. A hop that stays on the stack carries them again; one that leaves
 * it carries neither, nor `authorization`, as `fetch` itself would drop.
 */
export function installStackFetch(options: StackFetchOptions): void {
  const original = globalThis.fetch
  globalThis.fetch = (input: Request | URL | string, init?: RequestInit): Promise<Response> =>
    stackFetch(original, options, input, init, 0)
}

async function stackFetch(
  original: typeof fetch,
  options: StackFetchOptions,
  input: Request | URL | string,
  init: RequestInit | undefined,
  hops: number,
): Promise<Response> {
  const call = currentCall()
  const stack = options.origin()
  const url = input instanceof Request ? input.url : String(input)
  if (call === undefined || stack === null || originOf(url) !== stack || !hasStackHeaders(call, options.forwardingSecret)) {
    return original(input, init)
  }
  const request = new Request(input, init)
  addStackHeaders(request.headers, call, options.forwardingSecret)
  if (request.redirect !== "follow") return original(request)

  const replay = request.clone()
  const response = await original(new Request(request, { redirect: "manual" }))
  const location = response.headers.get("location")
  if (!REDIRECT_STATUSES.has(response.status) || location === null) return response
  if (hops >= MAX_REDIRECTS) throw new TypeError(`too many redirects fetching ${url}`)
  await response.body?.cancel()
  return stackFetch(original, options, ...redirected(replay, response.status, new URL(location, url), stack), hops + 1)
}

/** The next hop of a redirect, as `fetch` would make it: a 303, or a POST after 301 or 302, becomes a GET. */
function redirected(
  previous: Request,
  status: number,
  next: URL,
  stack: string,
): [string, RequestInit] {
  const toGet = status === 303 ? previous.method !== "HEAD" : (status === 301 || status === 302) && previous.method === "POST"
  const headers = new Headers(previous.headers)
  if (next.origin !== stack) {
    for (const name of [FORWARDED_FOR_HEADER, FORWARDING_SECRET_HEADER, HOOK_DEPTH_HEADER, "authorization"]) headers.delete(name)
  }
  if (toGet) for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(name)
  return [
    next.href,
    {
      method: toGet ? "GET" : previous.method,
      headers,
      redirect: "follow",
      signal: previous.signal,
      ...(!toGet && previous.body !== null && { body: previous.body, duplex: "half" }),
    } as RequestInit,
  ]
}
