import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * The server publishes the API URL and anon key at `/supatype-env.json` and `/supatype-env.js`, for
 * `supatype build` and a script tag. An API-only project turns that off with
 * `server.public_env: false`, rendered to the server as `SUPATYPE_PUBLIC_ENV=false`. Absent, nothing
 * is rendered and the server's own default (on) applies.
 */
const config = (server: Record<string, unknown> = {}): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "standalone", ...server },
      app: { mode: "none" },
      database: { provider: "docker" },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
    },
    "supatype.config.ts",
  )

/** The server service's environment lines, trimmed. */
function serverEnv(compose: string): string[] {
  const block = /^ {2}server:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n|(?![\s\S]))/m.exec(compose)?.[1] ?? ""
  return block.split("\n").map((line) => line.trim())
}

describe("server.public_env", () => {
  it("renders SUPATYPE_PUBLIC_ENV=false into the server, self-host and dev, when turned off", () => {
    for (const devLocal of [false, true]) {
      const lines = serverEnv(renderSelfHostCompose(config({ public_env: false }), process.cwd(), { devLocal }))
      expect(lines, `devLocal: ${devLocal}`).toContain('SUPATYPE_PUBLIC_ENV: "false"')
    }
  })

  it.each([[{}], [{ public_env: true }]])("renders nothing for %o, leaving the server's default", (server) => {
    expect(renderSelfHostCompose(config(server))).not.toContain("SUPATYPE_PUBLIC_ENV")
  })

  it("refuses a value that is not true or false", () => {
    expect(() => config({ public_env: "no" })).toThrow(/server\.public_env must be true or false/)
  })
})
