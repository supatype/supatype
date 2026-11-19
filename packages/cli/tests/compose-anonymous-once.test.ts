import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig } from "../src/project-config.js"

/**
 * The compose file's server service turned anonymous sign-in on from `.env` with a line of its own,
 * and `auth.anonymous.enabled` in the config adds the same key through the auth settings. With both,
 * the service named the key twice. The `.env` line is written only when the config does not set it.
 */
function compose(auth: Record<string, unknown>): string {
  const config = validateProjectConfig(
    { project: { name: "demo" }, database: {}, server: { mode: "self-host" }, app: { mode: "none" }, auth },
    "supatype.config.ts",
  )
  return renderSelfHostCompose(config)
}

const lines = (text: string): string[] => text.split("\n").filter((l) => l.trimStart().startsWith("SUPATYPE_EXTERNAL_ANONYMOUS_USERS_ENABLED:"))

describe("anonymous sign-in in the compose file", () => {
  it("is the .env line, off by default, when the config says nothing", () => {
    expect(lines(compose({}))).toEqual(["      SUPATYPE_EXTERNAL_ANONYMOUS_USERS_ENABLED: ${SUPATYPE_EXTERNAL_ANONYMOUS_USERS_ENABLED:-false}"])
  })

  it("is one line, with the config's value as its default, when the config sets it", () => {
    const found = lines(compose({ anonymous: { enabled: true } }))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(":-true")
  })
})
