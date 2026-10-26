import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { mergeProjectConfig, validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * Studio's sign-in offers every OAuth provider the auth server has enabled. `studio.auth.providers`
 * narrows that to the ones named. Studio reads it before anybody signs in, so it reaches Studio
 * the way its API URL and anon key do: in `SUPATYPE_CLOUD_JSON`, which the Studio container writes
 * into the page as `window.__SUPATYPE_CLOUD__` when it starts.
 */
const config = (studio?: unknown): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "standalone" as const },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
      ...(studio !== undefined && { studio }),
    },
    "supatype.config.ts",
  )

/** The JSON Studio's container writes into the page, with compose's own substitutions left in. */
function studioRuntimeJson(compose: string): Record<string, unknown> {
  const line = compose.split("\n").find((l) => l.trim().startsWith("SUPATYPE_CLOUD_JSON:"))
  const quoted = /SUPATYPE_CLOUD_JSON: '(.*)'$/.exec(line?.trim() ?? "")?.[1]
  if (quoted === undefined) throw new Error("no SUPATYPE_CLOUD_JSON line")
  const parsed: unknown = JSON.parse(quoted)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object")
  return Object.fromEntries(Object.entries(parsed))
}

describe("studio.auth.providers", () => {
  it("is passed to Studio when the project names providers", () => {
    const json = studioRuntimeJson(renderSelfHostCompose(config({ auth: { providers: ["keycloak", "github"] } })))
    expect(json["authProviders"]).toEqual(["keycloak", "github"])
    expect(json["url"]).toBe("${API_EXTERNAL_URL:-http://localhost:18473}")
    expect(json["anonKey"]).toBe("${ANON_KEY:-}")
  })

  it("passes nothing when the project names none, so Studio offers every enabled provider", () => {
    expect(studioRuntimeJson(renderSelfHostCompose(config()))).not.toHaveProperty("authProviders")
    expect(studioRuntimeJson(renderSelfHostCompose(config({})))).not.toHaveProperty("authProviders")
  })

  it("accepts a custom provider by its custom: name", () => {
    expect(() => config({ auth: { providers: ["custom:acme-sso"] } })).not.toThrow()
  })

  it("refuses names the auth server has no provider for, and shapes that are not a list", () => {
    for (const bad of [["keycloack"], ["email"], [""], [42], "keycloak", { keycloak: true }, ["custom:"], ["custom:x'y"]]) {
      expect(() => config({ auth: { providers: bad } }), JSON.stringify(bad)).toThrow(/studio\.auth\.providers/)
    }
  })

  it("is merged from a local config like other sections", () => {
    const merged = mergeProjectConfig(config({ auth: { providers: ["github"] } }), { studio: { auth: { providers: ["keycloak"] } } })
    expect(merged.studio?.auth?.providers).toEqual(["keycloak"])
  })
})
