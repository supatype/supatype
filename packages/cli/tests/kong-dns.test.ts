import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * EXT-N1: after a push recreated the server, Kong kept sending to the old container's address and
 * sign-in answered 502 until Kong was restarted. Docker's DNS answers service names with a 600 s
 * TTL, and Kong also serves a stale record for up to an hour while it refreshes, so a recreated
 * upstream was unreachable for minutes. Kong is told to look its upstreams up again within seconds.
 */
const config = validateProjectConfig(
  {
    project: { name: "acme" },
    server: { mode: "dev" },
    app: { mode: "none" },
    database: { provider: "docker" },
    versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
  },
  "supatype.config.ts",
)

function kongBlock(compose: string): string {
  const start = compose.indexOf("\n  kong:\n")
  expect(start).toBeGreaterThan(-1)
  const rest = compose.slice(start + 1)
  const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return end === -1 ? rest : rest.slice(0, end + 1)
}

describe("Kong's DNS cache", () => {
  for (const devLocal of [true, false]) {
    it(`re-resolves upstreams within seconds (${devLocal ? "dev" : "self-host"})`, () => {
      const kong = kongBlock(renderSelfHostCompose(config, process.cwd(), { devLocal }))
      expect(kong).toContain('KONG_DNS_VALID_TTL: "5"')
      expect(kong).toContain('KONG_DNS_STALE_TTL: "0"')
      expect(kong).toContain('KONG_DNS_NOT_FOUND_TTL: "1"')
      expect(kong).toContain('KONG_DNS_ERROR_TTL: "1"')
    })
  }
})
