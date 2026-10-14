import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * SHb: a standalone server's default CORS allowlist is the site URL plus the origins the project
 * names in `api.corsOrigins` and in the environment. The config list reaches the server through the
 * compose file; SUPATYPE_CORS_ALLOW_ORIGINS in `.env` adds to it rather than replacing it.
 */
const config = (api?: unknown): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "standalone" as const },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
      ...(api !== undefined && { api }),
    },
    "supatype.config.ts",
  )

function serverCorsLine(compose: string): string | undefined {
  const block = /^ {2}server:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(compose)?.[1] ?? ""
  return block.split("\n").find((l) => l.trim().startsWith("SUPATYPE_CORS_ALLOW_ORIGINS:"))?.trim()
}

describe("api.corsOrigins (SHb)", () => {
  it("renders the configured origins ahead of whatever .env adds", () => {
    const compose = renderSelfHostCompose(config({ corsOrigins: ["https://admin.example.com", "http://localhost:5173"] }))
    expect(serverCorsLine(compose)).toBe(
      'SUPATYPE_CORS_ALLOW_ORIGINS: "https://admin.example.com,http://localhost:5173,${SUPATYPE_CORS_ALLOW_ORIGINS:-}"',
    )
  })

  it("leaves the environment's list alone when the config names none", () => {
    expect(serverCorsLine(renderSelfHostCompose(config()))).toBe(
      'SUPATYPE_CORS_ALLOW_ORIGINS: "${SUPATYPE_CORS_ALLOW_ORIGINS:-}"',
    )
  })

  it("refuses an entry that is not an origin, or *, when the config is read", () => {
    for (const bad of ["admin.example.com", "https://admin.example.com/path", "ftp://x.example", 42, ""]) {
      expect(() => config({ corsOrigins: [bad] })).toThrow(/api\.corsOrigins/)
    }
    expect(() => config({ corsOrigins: "https://x.example" })).toThrow(/api\.corsOrigins/)
    expect(() => config({ corsOrigins: ["*", "https://x.example:8443"] })).not.toThrow()
  })
})
