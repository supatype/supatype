import { beforeEach, describe, expect, it, vi } from "vitest"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * Supatype Cloud refuses a literal `email.smtp.pass` or `email.resend_api_key`; self-host takes one
 * for now. Until the release that refuses it there too, a literal gets a warning that names the
 * `env("NAME")` form and says the next release refuses it, and never prints the value.
 */
const said = vi.hoisted(() => ({ warnings: [] as string[] }))
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  warn: (message: string) => void said.warnings.push(message),
}))

const SECRET = "literal-secret-value-xyz"

function raw(email: Record<string, unknown>): Record<string, unknown> {
  return {
    project: { name: "acme" },
    server: { mode: "standalone" as const },
    app: { mode: "none" as const },
    database: { provider: "docker" as const },
    versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
    email,
  }
}

async function load(email: Record<string, unknown>): Promise<void> {
  const { validateProjectConfig } = await import("../src/project-config.js")
  validateProjectConfig(raw(email), "supatype.config.ts")
}

beforeEach(() => {
  said.warnings.length = 0
  vi.resetModules()
})

describe("a literal email secret in a self-host config", () => {
  it("warns for email.smtp.pass, naming env(NAME) and the next release, without the value", async () => {
    await load({ provider: "smtp", smtp: { host: "mail.example.com", pass: SECRET } })
    expect(said.warnings).toHaveLength(1)
    const [warning] = said.warnings
    expect(warning).toContain("email.smtp.pass")
    expect(warning).toContain('env("NAME")')
    expect(warning).toContain("next release refuses")
    expect(warning).not.toContain(SECRET)
  })

  it("warns for email.resend_api_key", async () => {
    await load({ provider: "resend", resend_api_key: SECRET })
    expect(said.warnings.join("\n")).toContain("email.resend_api_key")
  })

  it("warns once however often the config is read", async () => {
    await load({ provider: "smtp", smtp: { host: "mail.example.com", pass: SECRET } })
    await load({ provider: "smtp", smtp: { host: "mail.example.com", pass: SECRET } })
    expect(said.warnings).toHaveLength(1)
  })

  it("says nothing for an env(NAME) reference", async () => {
    await load({ provider: "smtp", smtp: { host: "mail.example.com", pass: "env(SMTP_PASS)" } })
    expect(said.warnings).toEqual([])
  })
})
