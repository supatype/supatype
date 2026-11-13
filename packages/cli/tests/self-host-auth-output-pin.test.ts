import { describe, it, expect } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { composeAuthProviderEnv, nativeAuthProviderEnv } from "../src/auth-providers.js"
import { nativeAuthMailerEnv } from "../src/native-dev-env.js"
import { configMailerEnv } from "../src/config-mailer-env.js"
import { env } from "../src/config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * Pins what the self-host compose renderer and native dev write for a project that uses several
 * auth providers and an SMTP mailer, so moving the auth settings onto the shared model in
 * `@supatype/types` cannot change a self-hosted stack by one byte. Written against the code before
 * that move; it must pass unchanged after it.
 */
function config(): SupatypeProjectConfig {
  return validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "standalone" as const },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
      auth: {
        email: { enabled: true, enableConfirmations: false },
        providers: {
          github: { clientId: "gh-client", secret: env("GITHUB_SECRET") },
          google: { clientId: env("GOOGLE_ID"), secret: env("GOOGLE_SECRET"), skipNonceCheck: true },
          gitlab: { clientId: "gl", url: "https://gitlab.example.com", enabled: false, emailOptional: true },
          keycloak: { clientId: "kc", redirectUri: "https://api.example.com/auth/v1/callback" },
        },
      },
      email: {
        provider: "smtp" as const,
        smtp: { host: "smtp.example.com", port: 2525, user: "mailer", pass: "literal-pass", admin_email: "a@example.com", sender_name: "Acme" },
      },
    },
    "supatype.config.ts",
  )
}

/** The server service's environment lines, comments included, in order. */
function serverBlock(compose: string): string {
  return /^ {2}server:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(compose)?.[1] ?? ""
}

describe("self-host auth output is pinned", () => {
  it("compose server environment", () => {
    const block = serverBlock(renderSelfHostCompose(config()))
    const envStart = block.indexOf("    environment:")
    expect(envStart).toBeGreaterThan(-1)
    expect(block.slice(envStart, block.indexOf("    depends_on:"))).toMatchSnapshot()
  })

  it("compose provider lines", () => {
    expect(composeAuthProviderEnv(config(), "${API_EXTERNAL_URL}")).toMatchSnapshot()
  })

  it("native provider and mailer environment", () => {
    const environment = { GITHUB_SECRET: "gh-s", GOOGLE_ID: "g-id", GOOGLE_SECRET: "g-s" }
    expect(nativeAuthProviderEnv(config(), "http://localhost:3001", environment)).toMatchSnapshot()
    expect(nativeAuthMailerEnv(config().email, "3001")).toMatchSnapshot()
    expect(configMailerEnv(config())).toMatchSnapshot()
  })
})
