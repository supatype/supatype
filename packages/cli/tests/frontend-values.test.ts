import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { signJwt } from "../src/jwt.js"
import { tempProject } from "./support/command-run.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Issue 29: a production build got no anon key from any CLI path, so the site built and rendered a
 * blank page. One resolver finds the deployment's API URL and anon key, each on its own: the
 * environment first (a host's own settings win), then the linked environment, then a `.env` that
 * records a deployment. A local address is refused unless asked for, the service role key never
 * comes back, and a refusal names every source it tried.
 */
const loadConfig = vi.fn((): SupatypeProjectConfig => projectConfig({ project: { name: "acme" } }))
vi.mock("../src/config.js", async (importOriginal) => ({ ...(await importOriginal<object>()), loadConfig }))

const { resolveFrontendValues, FrontendValuesRefused } = await import("../src/frontend-values.js")

const SECRET = "frontend-values-test-secret-32-chars!!"
const ANON = signJwt({ iss: "supatype", role: "anon" }, SECRET)
const SERVICE = signJwt({ iss: "supatype", role: "service_role" }, SECRET)
const API = "https://api.example.com"

let project: { dir: string; remove: () => void }
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  project = tempProject("frontend-values")
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "")
  vi.stubEnv("SUPATYPE_TOKEN", "")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  project.remove()
})

function writeDotEnv(lines: Record<string, string>): void {
  writeFileSync(join(project.dir, ".env"), Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(""))
}

function writeLink(kind: "cloud" | "self-host", apiUrl: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  const env = { name: "production", apiUrl, linkedAt: "2026-01-01T00:00:00Z" }
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
    version: 1, kind, projectRef: "acme", defaultEnvironment: "production",
    environments: { production: env, staging: { ...env, name: "staging", apiUrl: apiUrl.replace("api.", "staging.") } },
    ...extra,
  }))
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const resolve = (over: { env?: string; allowLocal?: boolean; processEnv?: NodeJS.ProcessEnv } = {}) =>
  resolveFrontendValues({ cwd: project.dir, processEnv: {}, ...over })

async function refusal(promise: Promise<unknown>): Promise<string> {
  const err: unknown = await promise.then(() => undefined, (e: unknown) => e)
  expect(err).toBeInstanceOf(FrontendValuesRefused)
  return err instanceof Error ? err.message : ""
}

describe("resolveFrontendValues: the environment", () => {
  it.each([
    ["SUPATYPE_URL", "SUPATYPE_ANON_KEY"],
    ["VITE_SUPATYPE_URL", "VITE_SUPATYPE_ANON_KEY"],
    ["PUBLIC_SUPATYPE_URL", "PUBLIC_SUPATYPE_ANON_KEY"],
    ["NEXT_PUBLIC_SUPATYPE_URL", "NEXT_PUBLIC_SUPATYPE_ANON_KEY"],
    ["EXPO_PUBLIC_SUPATYPE_URL", "EXPO_PUBLIC_SUPATYPE_ANON_KEY"],
  ])("takes %s and %s", async (urlName, keyName) => {
    const values = await resolve({ processEnv: { [urlName]: API, [keyName]: ANON } })
    expect(values).toMatchObject({ apiUrl: API, anonKey: ANON })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("wins over the link and .env, which are not read for a value it holds", async () => {
    writeLink("self-host", "https://api.linked.example")
    writeDotEnv({ API_EXTERNAL_URL: "https://dotenv.example", ANON_KEY: "dotenv-key" })
    const values = await resolve({ processEnv: { SUPATYPE_URL: API, SUPATYPE_ANON_KEY: ANON } })
    expect(values).toMatchObject({ apiUrl: API, anonKey: ANON })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("resolveFrontendValues: each value on its own", () => {
  it("takes the URL from the environment and the key from the self-host server", async () => {
    writeLink("self-host", "https://api.linked.example")
    fetchMock.mockResolvedValue(json({ url: "https://api.linked.example", anonKey: ANON }))
    const values = await resolve({ processEnv: { VITE_SUPATYPE_URL: API } })
    expect(values).toMatchObject({ apiUrl: API, anonKey: ANON })
  })

  it("takes the key from the environment and the URL from .env", async () => {
    writeDotEnv({ API_EXTERNAL_URL: "https://dotenv.example", ANON_KEY: "dotenv-key" })
    const values = await resolve({ processEnv: { SUPATYPE_ANON_KEY: ANON } })
    expect(values).toMatchObject({ apiUrl: "https://dotenv.example", anonKey: ANON })
  })
})

describe("resolveFrontendValues: a self-host link", () => {
  it("uses the link's address and the anon key its server publishes", async () => {
    writeLink("self-host", "https://api.linked.example")
    fetchMock.mockResolvedValue(json({ url: "https://api.linked.example", anonKey: ANON }))
    const values = await resolve()
    expect(values).toMatchObject({ apiUrl: "https://api.linked.example", anonKey: ANON })
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.linked.example/supatype-env.json")
  })

  it("asks the environment --env names", async () => {
    writeLink("self-host", "https://api.linked.example")
    fetchMock.mockResolvedValue(json({ url: "https://staging.linked.example", anonKey: ANON }))
    const values = await resolve({ env: "staging" })
    expect(values.apiUrl).toBe("https://staging.linked.example")
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://staging.linked.example/supatype-env.json")
  })

  it("never fetches the key over plain HTTP from an address that is not local", async () => {
    writeLink("self-host", "http://api.linked.example")
    const message = await refusal(resolve())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(message).toMatch(/only fetched over HTTPS/)
  })

  it("says plainly when the server has the address turned off (404)", async () => {
    writeLink("self-host", "https://api.linked.example")
    fetchMock.mockResolvedValue(json({ error: "not_found" }, 404))
    const message = await refusal(resolve())
    expect(message).toContain("https://api.linked.example/supatype-env.json answered 404")
    expect(message).toContain("server.public_env")
  })

  it("says a misconfigured server (503) is not set up, quoting its reason on one line and no JWT", async () => {
    writeLink("self-host", "https://api.linked.example")
    const said = `SUPATYPE_ANON_KEY holds a service role key:\n${SERVICE}`
    fetchMock.mockResolvedValue(json({ error: "misconfigured", message: said }, 503))
    const message = await refusal(resolve())
    expect(message).toContain("the server at https://api.linked.example is not set up to publish its anon key: SUPATYPE_ANON_KEY holds a service role key:")
    expect(message).not.toContain(SERVICE)
    expect(message).not.toMatch(/eyJ[\w-]+\.[\w-]+/)
    expect(message.split("\n").filter((line) => line.includes("not set up to publish"))).toHaveLength(1)
    expect(message).not.toMatch(/service role key:\n/)
  })

  it("quotes a plain-text 503 body the same way", async () => {
    writeLink("self-host", "https://api.linked.example")
    fetchMock.mockResolvedValue(new Response("no anon key configured\n", { status: 503 }))
    expect(await refusal(resolve())).toContain("the server at https://api.linked.example is not set up to publish its anon key: no anon key configured")
  })

  it("reports a server that does not answer, naming it", async () => {
    writeLink("self-host", "https://api.linked.example")
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.linked.example"))
    const message = await refusal(resolve())
    expect(message).toContain("ENOTFOUND")
  })
})

describe("resolveFrontendValues: a Cloud link", () => {
  it("reads the anon key from the control plane's keys route, and the environment's own address", async () => {
    writeLink("cloud", "https://acme.supatype.dev", { cloudApiUrl: "https://cp.example", token: "user-jwt" })
    fetchMock.mockResolvedValue(json({ data: { name: "production", anonKey: ANON, serviceRoleKey: SERVICE } }))
    const values = await resolve()
    expect(values).toMatchObject({ apiUrl: "https://acme.supatype.dev", anonKey: ANON })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://cp.example/api/v1/projects/acme/environments/production/keys")
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer user-jwt")
    expect(JSON.stringify(values)).not.toContain(SERVICE)
  })

  it("reports a control plane that refuses the keys", async () => {
    writeLink("cloud", "https://acme.supatype.dev", { cloudApiUrl: "https://cp.example", token: "user-jwt" })
    fetchMock.mockResolvedValue(json({ error: "forbidden", message: "Only owner/admin can access environment keys" }, 403))
    expect(await refusal(resolve())).toContain("Only owner/admin can access environment keys")
  })
})

/**
 * Self-host CI that sets only the URL: the anon key comes from that server's public address, as it
 * does for a self-host link, with the same HTTPS and 404 rules.
 */
describe("resolveFrontendValues: the server the environment's URL names", () => {
  it("fetches the anon key from <SUPATYPE_URL>/supatype-env.json when nothing else holds it", async () => {
    fetchMock.mockResolvedValue(json({ url: API, anonKey: ANON }))
    const values = await resolve({ processEnv: { SUPATYPE_URL: API } })
    expect(values).toMatchObject({ apiUrl: API, anonKey: ANON })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API}/supatype-env.json`)
  })

  it("asks it before the link, so the key is the one the URL's own server holds", async () => {
    writeLink("self-host", "https://api.linked.example")
    fetchMock.mockResolvedValue(json({ url: API, anonKey: ANON }))
    const values = await resolve({ processEnv: { NEXT_PUBLIC_SUPATYPE_URL: API } })
    expect(values).toMatchObject({ apiUrl: API, anonKey: ANON })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${API}/supatype-env.json`])
  })
})

/**
 * The anon key has to belong to the deployment the URL names. With a link to one deployment and
 * SUPATYPE_URL naming another, the build shipped the second's address with the first's key.
 */
describe("resolveFrontendValues: the key belongs to the URL being built for", () => {
  const OTHER = signJwt({ iss: "supatype", role: "anon", ref: "other" }, SECRET)

  it("skips the link's key when the environment's URL names another deployment, saying so", async () => {
    writeLink("self-host", "https://api.linked.example")
    fetchMock.mockImplementation(async (url) => url.startsWith(API)
      ? json({ error: "not_found" }, 404)
      : json({ url: "https://api.linked.example", anonKey: OTHER }))
    const message = await refusal(resolve({ processEnv: { SUPATYPE_URL: API } }))
    expect(message).toMatch(/skipped +anon key from linked environment "production" \(self-host\): for https:\/\/api\.linked\.example, not the URL being built for/)
    expect(message).not.toContain(OTHER)
  })

  it("skips .env's key when .env records another deployment", async () => {
    writeDotEnv({ API_EXTERNAL_URL: "https://dotenv.example", ANON_KEY: OTHER })
    fetchMock.mockResolvedValue(json({ error: "not_found" }, 404))
    const message = await refusal(resolve({ processEnv: { SUPATYPE_URL: API } }))
    expect(message).toMatch(/skipped +anon key from \.env: for https:\/\/dotenv\.example, not the URL being built for/)
  })

  it("takes a key whose address differs only in case, default port, trailing slash or /auth/v1", async () => {
    writeDotEnv({ API_EXTERNAL_URL: "https://API.example.com:443/auth/v1/", ANON_KEY: ANON })
    fetchMock.mockResolvedValue(json({ error: "not_found" }, 404))
    expect(await resolve({ processEnv: { SUPATYPE_URL: API } })).toMatchObject({ apiUrl: API, anonKey: ANON })
  })

  it("takes a key set in the environment whatever the URL, since the host's settings say which deployment", async () => {
    writeLink("self-host", "https://api.linked.example")
    expect(await resolve({ processEnv: { SUPATYPE_ANON_KEY: ANON } })).toMatchObject({ apiUrl: "https://api.linked.example", anonKey: ANON })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("resolveFrontendValues: the server the environment's URL names, refusals", () => {
  it("never fetches over plain HTTP from an address that is not local", async () => {
    const message = await refusal(resolve({ processEnv: { SUPATYPE_URL: "http://api.example.com" } }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(message).toMatch(/anon key from the server SUPATYPE_URL names: .*only fetched over HTTPS/)
  })

  it("never fetches from a local address without allowLocal, and does with it", async () => {
    await refusal(resolve({ processEnv: { SUPATYPE_URL: "http://localhost:8000" } }))
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(json({ url: "http://localhost:8000", anonKey: ANON }))
    expect((await resolve({ allowLocal: true, processEnv: { SUPATYPE_URL: "http://localhost:8000" } })).anonKey).toBe(ANON)
  })

  it("reports a 404 as the address being turned off", async () => {
    fetchMock.mockResolvedValue(json({ error: "not_found" }, 404))
    const message = await refusal(resolve({ processEnv: { SUPATYPE_URL: API } }))
    expect(message).toContain(`${API}/supatype-env.json answered 404`)
    // It said "or is older than the address", which reads as nothing.
    expect(message).toContain("server.public_env set to false, or runs a release too old to serve it")
    expect(message).toContain("SUPATYPE_ANON_KEY")
  })
})

describe("resolveFrontendValues: .env", () => {
  it("takes a deployment's address and ANON_KEY, never SERVICE_ROLE_KEY", async () => {
    writeDotEnv({ API_EXTERNAL_URL: API, ANON_KEY: ANON, SERVICE_ROLE_KEY: SERVICE })
    const values = await resolve()
    expect(values).toMatchObject({ apiUrl: API, anonKey: ANON })
    expect(JSON.stringify(values)).not.toContain(SERVICE)
  })

  it("prefers PUBLIC_SUPATYPE_URL to API_EXTERNAL_URL", async () => {
    writeDotEnv({ PUBLIC_SUPATYPE_URL: "https://public.example", API_EXTERNAL_URL: API, ANON_KEY: ANON })
    expect((await resolve()).apiUrl).toBe("https://public.example")
  })
})

describe("resolveFrontendValues: refusals", () => {
  it("refuses a local address, naming where it came from and --allow-local", async () => {
    const message = await refusal(resolve({ processEnv: { VITE_SUPATYPE_URL: "http://localhost:8000", SUPATYPE_ANON_KEY: ANON } }))
    expect(message).toContain("VITE_SUPATYPE_URL=http://localhost:8000")
    expect(message).toContain("--allow-local")
  })

  it("takes a local address with allowLocal", async () => {
    writeDotEnv({ API_EXTERNAL_URL: "http://localhost:8000", ANON_KEY: ANON })
    expect(await resolve({ allowLocal: true })).toMatchObject({ apiUrl: "http://localhost:8000", anonKey: ANON })
  })

  it("does not take a local stack's ANON_KEY from .env", async () => {
    writeDotEnv({ API_EXTERNAL_URL: "http://127.0.0.1:8000", ANON_KEY: ANON })
    const message = await refusal(resolve({ processEnv: { SUPATYPE_URL: API } }))
    expect(message).toMatch(/ANON_KEY in \.env is a local stack's/)
  })

  it("refuses a service role key handed over as the anon key, without printing it", async () => {
    const message = await refusal(resolve({ processEnv: { SUPATYPE_URL: API, NEXT_PUBLIC_SUPATYPE_ANON_KEY: SERVICE } }))
    expect(message).toMatch(/NEXT_PUBLIC_SUPATYPE_ANON_KEY holds a service role key/)
    expect(message).not.toContain(SERVICE)
  })

  it("names every source tried and the fix when nothing holds the values", async () => {
    const message = await refusal(resolve())
    expect(message).toMatch(/No API URL and no anon key/)
    expect(message).toMatch(/not set +API URL from the environment: none of SUPATYPE_URL, VITE_SUPATYPE_URL/)
    expect(message).toMatch(/not set +anon key from the linked environment: no \.supatype\/link\.json/)
    expect(message).toMatch(/not set +anon key from \.env: no ANON_KEY/)
    expect(message).toContain("supatype build --env <name>")
    expect(message).toContain("SUPATYPE_ANON_KEY")
  })
})
