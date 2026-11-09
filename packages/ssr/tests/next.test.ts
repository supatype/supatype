/**
 * `@supatype/ssr/next`: `/supatype-env.js` served by a Next.js app, from the server's environment.
 *
 * `next build` prerenders the app's pages without the deployment's values. The route below answers
 * every page load with the ones the running server has, in the same body, headers and refusals as
 * the Supatype server's own `/supatype-env.js`, so one build runs on any deployment.
 */
import { runInNewContext } from "node:vm"
import { afterEach, assert, describe, expect, it, vi } from "vitest"
import { GET, dynamic } from "../src/next.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

/** An unsigned JWT carrying `role`. */
function jwtFor(role: string): string {
  return `e30.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.sig`
}

/** Set the two variables the route reads; undefined removes one. */
function serverEnv(url: string | undefined, anonKey: string | undefined): void {
  vi.stubEnv("SUPATYPE_URL", url)
  vi.stubEnv("SUPATYPE_ANON_KEY", anonKey)
}

/** What the page's global holds after running `body`, as a browser would. */
function pageEnvAfter(body: string): unknown {
  const window: Record<string, unknown> = {}
  runInNewContext(body, { window })
  return window["__SUPATYPE_ENV__"]
}

/**
 * The reason a misconfigured route gives the page. A browser runs no script answered with an error
 * status and tells the page nothing of why, so the route answers 200, kept by nothing, with a
 * script that sets only `error`: the one way the client can name the fault on its first call.
 */
async function reasonFrom(res: Response): Promise<{ error: string; body: string }> {
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8")
  expect(res.headers.get("cache-control")).toBe("no-store")
  expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  const body = await res.text()
  const env = pageEnvAfter(body)
  assert(typeof env === "object" && env !== null && "error" in env && typeof env.error === "string")
  expect(Object.keys(env)).toEqual(["error"])
  return { error: env.error, body }
}

describe("GET /supatype-env.js", () => {
  it("is never prerendered", () => {
    expect(dynamic).toBe("force-dynamic")
  })

  it("sets window.__SUPATYPE_ENV__ to the server's address and anon key", async () => {
    serverEnv("https://api.example.com", "anon-key")
    const res = GET()

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('window.__SUPATYPE_ENV__ = {"url":"https://api.example.com","anonKey":"anon-key"};\n')
  })

  it("carries the server's headers: a script, revalidated on every load, never sniffed", () => {
    serverEnv("https://api.example.com", "anon-key")
    const res = GET()

    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8")
    expect(res.headers.get("cache-control")).toBe("no-cache")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("reads the environment per request, so one build serves whichever values it runs with", async () => {
    serverEnv("https://one.example.com", "key-one")
    const first = pageEnvAfter(await GET().text())
    serverEnv("https://two.example.com", "key-two")
    const second = pageEnvAfter(await GET().text())

    expect(first).toEqual({ url: "https://one.example.com", anonKey: "key-one" })
    expect(second).toEqual({ url: "https://two.example.com", anonKey: "key-two" })
  })

  it("sets only the reason, 200 no-store, naming the variable, when the address is unset", async () => {
    serverEnv(undefined, "anon-key")
    const { error, body } = await reasonFrom(GET())

    expect(error).toBe("public env unavailable: SUPATYPE_URL is not set on this server")
    expect(body).not.toContain("anon-key")
  })

  it("trims the address as the server does", async () => {
    serverEnv(" https://api.example.com/auth/v1/ ", " anon-key ")
    expect(pageEnvAfter(await GET().text())).toEqual({ url: "https://api.example.com", anonKey: "anon-key" })
  })

  it("escapes what could end the script element or the statement", async () => {
    const hostile = "</script><script>alert(1)</script>\u2028\u2029&"
    serverEnv("https://api.example.com", hostile)
    const body = await GET().text()

    expect(body).not.toContain("</script>")
    expect(body).not.toMatch(/[<>&\u2028\u2029]/)
    expect(pageEnvAfter(body)).toEqual({ url: "https://api.example.com", anonKey: hostile })
  })

  it("sets only the reason, 200 no-store, naming the variable, when the anon key is unset", async () => {
    serverEnv("https://api.example.com", undefined)
    const { error } = await reasonFrom(GET())

    expect(error).toBe("public env unavailable: SUPATYPE_ANON_KEY is not set on this server")
  })

  it("names every unset setting in one reason, the anon key first, so one fix covers both", async () => {
    serverEnv(undefined, undefined)
    const { body } = await reasonFrom(GET())

    expect(body).toBe(
      'window.__SUPATYPE_ENV__ = {"error":"public env unavailable: SUPATYPE_ANON_KEY is not set on this server\\n' +
        'public env unavailable: SUPATYPE_URL is not set on this server"};\n',
    )
  })

  it("names an unset address beside a service role anon key, whose refusal reads as before", async () => {
    const service = jwtFor("service_role")
    serverEnv(undefined, service)
    const { error, body } = await reasonFrom(GET())
    const lines = error.split("\n")

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("holds a service_role token")
    expect(lines[1]).toBe("public env unavailable: SUPATYPE_URL is not set on this server")
    expect(body).not.toContain(service)
  })

  it.each(["false", "0", "no", "off", " FALSE "])("is 404 no-store when SUPATYPE_PUBLIC_ENV is %j", async (off) => {
    serverEnv("https://api.example.com", "anon-key")
    vi.stubEnv("SUPATYPE_PUBLIC_ENV", off)
    const res = GET()

    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.text()).not.toContain("anon-key")
  })

  it.each(["", "true", "1", "yes", "on"])("serves when SUPATYPE_PUBLIC_ENV is %j", (on) => {
    serverEnv("https://api.example.com", "anon-key")
    vi.stubEnv("SUPATYPE_PUBLIC_ENV", on)
    expect(GET().status).toBe(200)
  })

  it("sets only the reason for a SUPATYPE_PUBLIC_ENV it cannot read, naming it and the words it takes", async () => {
    serverEnv("https://api.example.com", "anon-key")
    vi.stubEnv("SUPATYPE_PUBLIC_ENV", "nope")
    const { error, body } = await reasonFrom(GET())

    expect(error).toContain('SUPATYPE_PUBLIC_ENV="nope"')
    for (const word of ["true", "1", "yes", "on", "false", "0", "no", "off"]) expect(error).toContain(word)
    expect(body).not.toContain("anon-key")
  })

  it("never serves a service role value", async () => {
    const service = jwtFor("service_role")
    serverEnv("https://api.example.com", "anon-key")
    vi.stubEnv("SUPATYPE_SERVICE_ROLE_KEY", service)
    vi.stubEnv("SERVICE_ROLE_KEY", service)

    expect(await GET().text()).not.toContain(service)
  })

  it("sets only the reason for an anon key that is a service role token, rather than publish it", async () => {
    const service = jwtFor("service_role")
    serverEnv("https://api.example.com", service)
    const { error, body } = await reasonFrom(GET())

    expect(body).not.toContain(service)
    expect(error).toContain("service_role")
  })

  it("serves an anon key that is an anon token", async () => {
    const anon = jwtFor("anon")
    serverEnv("https://api.example.com", anon)
    expect(pageEnvAfter(await GET().text())).toEqual({ url: "https://api.example.com", anonKey: anon })
  })
})
