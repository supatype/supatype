import { describe, it, expect } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { nativeAuthProviderEnv } from "../src/auth-providers.js"
import { env } from "../src/config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * OAuth providers from `auth.providers` in supatype.config.ts.
 *
 * They used to be configurable only as SUPATYPE_EXTERNAL_<PROVIDER>_* lines in `.env`, and the
 * server refuses a provider without a redirect URI. The one that works behind the gateway is
 * `<public API URL>/auth/v1/callback`: the server's own routes sit under `/auth/v1/` there, as the
 * emailed links do (compose-email-links.test.ts). Nothing said so, so every project had to find it.
 */
const SECRET_VALUE = "gh-secret-value-that-must-not-be-rendered"

function config(auth?: unknown): SupatypeProjectConfig {
  return validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "dev" as const },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
      ...(auth !== undefined && { auth }),
    },
    "supatype.config.ts",
  )
}

const github = (extra: Record<string, unknown> = {}) => ({
  providers: { github: { clientId: "gh-client", secret: env("GITHUB_SECRET"), ...extra } },
})

/** The server service's environment, as `KEY: value` pairs. */
function serverEnv(compose: string): Map<string, string> {
  const block = /^ {2}server:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(compose)?.[1] ?? ""
  const out = new Map<string, string>()
  for (const line of block.split("\n")) {
    const match = /^\s{6}([A-Z_]+):\s*(.*)$/.exec(line)
    if (match?.[1] !== undefined) out.set(match[1], (match[2] ?? "").replace(/^"|"$/g, ""))
  }
  return out
}

describe("auth.providers in the compose stack", () => {
  it("defaults a provider's redirect URI to the gateway's /auth/v1/callback", () => {
    const vars = serverEnv(renderSelfHostCompose(config(github())))
    expect(vars.get("SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI")).toBe(
      "${SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI:-${API_EXTERNAL_URL:-http://localhost:${SUPATYPE_KONG_PORT:-18473}}/auth/v1/callback}",
    )
  })

  it("enables the provider and passes the client id, each overridable from .env", () => {
    const vars = serverEnv(renderSelfHostCompose(config(github())))
    expect(vars.get("SUPATYPE_EXTERNAL_GITHUB_ENABLED")).toBe("${SUPATYPE_EXTERNAL_GITHUB_ENABLED:-true}")
    expect(vars.get("SUPATYPE_EXTERNAL_GITHUB_CLIENT_ID")).toBe(
      "${SUPATYPE_EXTERNAL_GITHUB_CLIENT_ID:-gh-client}",
    )
  })

  it("names the secret's variable and never writes a value", () => {
    const compose = renderSelfHostCompose(config(github()))
    expect(serverEnv(compose).get("SUPATYPE_EXTERNAL_GITHUB_SECRET")).toBe(
      "${SUPATYPE_EXTERNAL_GITHUB_SECRET:-${GITHUB_SECRET:-}}",
    )
    expect(compose).not.toContain(SECRET_VALUE)
  })

  it("keeps a stated redirect URI and provider URL", () => {
    const vars = serverEnv(
      renderSelfHostCompose(
        config(github({ redirectUri: "https://api.example.com/auth/v1/callback", url: "https://ghe.example.com" })),
      ),
    )
    expect(vars.get("SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI")).toBe(
      "${SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI:-https://api.example.com/auth/v1/callback}",
    )
    expect(vars.get("SUPATYPE_EXTERNAL_GITHUB_URL")).toBe("${SUPATYPE_EXTERNAL_GITHUB_URL:-https://ghe.example.com}")
  })

  it("uses the env names the server reads for the two-word providers", () => {
    const vars = serverEnv(
      renderSelfHostCompose(config({ providers: { linkedin_oidc: { clientId: "li", secret: env("LI_SECRET") } } })),
    )
    expect(vars.has("SUPATYPE_EXTERNAL_LINKEDIN_OIDC_CLIENT_ID")).toBe(true)
  })

  it("renders nothing for a project without providers, so .env alone still configures them", () => {
    const compose = renderSelfHostCompose(config())
    expect(compose).not.toContain("SUPATYPE_EXTERNAL_")
  })

  it("uses the https domain for the default redirect when TLS is on", () => {
    const tls = validateProjectConfig(
      {
        project: { name: "acme" },
        server: { mode: "standalone", domain: "api.example.com", tls: { email: "ops@example.com" } },
        app: { mode: "none" },
        database: { provider: "docker" },
        versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
        auth: github(),
      },
      "supatype.config.ts",
    )
    expect(serverEnv(renderSelfHostCompose(tls)).get("SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI")).toBe(
      "${SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI:-${API_EXTERNAL_URL:-https://api.example.com}/auth/v1/callback}",
    )
  })
})

describe("auth.providers validation", () => {
  it("refuses a provider the auth server does not have", () => {
    expect(() => config({ providers: { githb: { clientId: "x" } } })).toThrow(/auth\.providers\.githb.*github/s)
  })

  it("refuses a secret written into the config", () => {
    expect(() => config({ providers: { github: { clientId: "x", secret: SECRET_VALUE } } })).toThrow(
      /auth\.providers\.github\.secret.*env\("/s,
    )
  })

  it("refuses a value that would break out of the compose line", () => {
    expect(() => config({ providers: { github: { clientId: "a}b" } } })).toThrow(/auth\.providers\.github\.clientId/)
    expect(() => config({ providers: { github: { clientId: "a$b" } } })).toThrow(/auth\.providers\.github\.clientId/)
  })

  it("refuses an env reference that is not a variable name", () => {
    expect(() => config({ providers: { github: { clientId: "x", secret: "env(not a name)" } } })).toThrow(
      /auth\.providers\.github\.secret/,
    )
  })

  it("accepts every field it documents", () => {
    expect(() =>
      config({
        providers: {
          google: {
            enabled: false,
            clientId: env("GOOGLE_CLIENT_ID"),
            secret: env("GOOGLE_SECRET"),
            redirectUri: "https://api.example.com/auth/v1/callback",
            url: "https://accounts.example.com",
            skipNonceCheck: true,
            emailOptional: true,
          },
        },
      }),
    ).not.toThrow()
  })
})

describe("auth.providers in native dev", () => {
  it("resolves the secret from the environment and defaults the redirect to the server's callback", () => {
    const vars = nativeAuthProviderEnv(config(github()), "http://localhost:54321", { GITHUB_SECRET: SECRET_VALUE })
    expect(vars).toEqual({
      SUPATYPE_EXTERNAL_GITHUB_ENABLED: "true",
      SUPATYPE_EXTERNAL_GITHUB_CLIENT_ID: "gh-client",
      SUPATYPE_EXTERNAL_GITHUB_SECRET: SECRET_VALUE,
      SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI: "http://localhost:54321/auth/v1/callback",
    })
  })

  it("leaves the secret unset when its variable is missing, for .env's own key to supply", () => {
    const vars = nativeAuthProviderEnv(config(github()), "http://localhost:54321", {})
    expect(vars).not.toHaveProperty("SUPATYPE_EXTERNAL_GITHUB_SECRET")
  })
})

describe("env()", () => {
  it("is the env(NAME) reference Supabase's config.toml uses", () => {
    expect(env("GITHUB_SECRET")).toBe("env(GITHUB_SECRET)")
  })
})
