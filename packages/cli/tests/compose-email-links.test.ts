import { describe, it, expect } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * The links the auth server emails must reach it through the gateway.
 *
 * The server builds each link as SUPATYPE_API_EXTERNAL_URL plus a path, and the external URL in a
 * compose stack is the gateway's root (API_EXTERNAL_URL), where `/` belongs to the app. The
 * server's default path is `/verify`, so every confirmation, magic-link, recovery and invite link
 * pointed at `<gateway>/verify`, which the gateway sends to the app route and the server answers
 * 404. The auth routes live under `/auth/v1/`, so that is where the links have to point.
 */
const config = (): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "dev" as const },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
    },
    "supatype.config.ts",
  )

/** The server service's environment, as `KEY: value` pairs. */
function serverEnv(compose: string): Map<string, string> {
  const block = /^ {2}server:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(compose)?.[1] ?? ""
  const env = new Map<string, string>()
  for (const line of block.split("\n")) {
    const match = /^\s{6}([A-Z_]+):\s*(.*)$/.exec(line)
    if (match?.[1] !== undefined) env.set(match[1], (match[2] ?? "").replace(/^"|"$/g, ""))
  }
  return env
}

describe("emailed auth links", () => {
  for (const kind of ["CONFIRMATION", "INVITE", "RECOVERY", "EMAIL_CHANGE"]) {
    it(`sends ${kind.toLowerCase()} links to /auth/v1/verify, under the gateway's auth route`, () => {
      const env = serverEnv(renderSelfHostCompose(config()))
      expect(env.get("SUPATYPE_API_EXTERNAL_URL"), "the server block was not found").toBeDefined()
      expect(env.get(`SUPATYPE_MAILER_URLPATHS_${kind}`)).toBe("/auth/v1/verify")
    })
  }
})
