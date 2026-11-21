import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * RB-5: the auth server's per-client limits (verify, OTP, sign-up, recover, token) count requests
 * per address, and it reads the address from SUPATYPE_RATE_LIMIT_HEADER. The compose never set it,
 * so no request through Kong was ever counted. Kong writes X-Real-IP from the connection itself and
 * replaces whatever the client sent, where X-Forwarded-For keeps the client's own text at the front.
 */
const config = (mode: "standalone" | "dev"): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
    },
    "supatype.config.ts",
  )

function serverEnvLine(compose: string, name: string): string | undefined {
  const block = /^ {2}server:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(compose)?.[1] ?? ""
  return block.split("\n").find((l) => l.trim().startsWith(`${name}:`))?.trim()
}

describe("auth rate limit header (RB-5)", () => {
  it.each(["standalone", "dev"] as const)("keys the %s server's per-client limits on Kong's X-Real-IP", (mode) => {
    expect(serverEnvLine(renderSelfHostCompose(config(mode)), "SUPATYPE_RATE_LIMIT_HEADER")).toBe(
      'SUPATYPE_RATE_LIMIT_HEADER: "${SUPATYPE_RATE_LIMIT_HEADER:-X-Real-IP}"',
    )
  })
})
