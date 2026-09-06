import { describe, it, expect } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * Compose must not hand the server a value it cannot parse.
 *
 * Every variable here is substituted by compose whether or not anyone set it,
 * and an unset one becomes the empty string. That is harmless for a host or a
 * password and fatal for a port: the server decodes it as an int, fails on "",
 * and exits before it binds. The whole stack then presents as "the gateway
 * never came up", which is a long way from the cause.
 */
const base = {
  project: { name: "acme" },
  server: { mode: "dev" as const },
  app: { mode: "none" as const },
  database: { provider: "docker" as const },
  versions: {
    postgres: "17.2",
    deno: DENO_RELEASE_PIN,
  },
}

const config = (): SupatypeProjectConfig => validateProjectConfig(base, "supatype.config.ts")

/** The `KEY: ${VAR:-default}` lines from the rendered compose file. */
function defaultsFor(compose: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of compose.split("\n")) {
    const match = /^\s*([A-Z_]+):\s*\$\{[A-Z_]+:-(.*)\}\s*$/.exec(line)
    if (match?.[1] !== undefined) found.set(match[1], match[2] ?? "")
  }
  return found
}

describe("compose defaults the server has to be able to parse", () => {
  it("gives SMTP_PORT a number, because an unset variable becomes an empty string", () => {
    const defaults = defaultsFor(renderSelfHostCompose(config()))
    const port = defaults.get("SUPATYPE_SMTP_PORT")

    expect(port, "SUPATYPE_SMTP_PORT is missing from the compose file").toBeDefined()
    expect(port, "an empty default makes the server exit on boot").not.toBe("")
    expect(Number.isInteger(Number(port))).toBe(true)
  })

  it("leaves the string-valued mailer settings empty, which the server accepts", () => {
    const defaults = defaultsFor(renderSelfHostCompose(config()))
    for (const key of [
      "SUPATYPE_SMTP_HOST",
      "SUPATYPE_SMTP_USER",
      "SUPATYPE_SMTP_PASS",
      "SUPATYPE_SMTP_ADMIN_EMAIL",
      "SUPATYPE_SMTP_SENDER_NAME",
    ]) {
      expect(defaults.get(key), `${key} should be present`).toBeDefined()
    }
  })
})
