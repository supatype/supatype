import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { nativeServerDotEnvLayer } from "../src/native-dev-env.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { renderSelfHostCompose } from "../src/self-host-compose.js"

/**
 * 0.9.2 (D5): the auth server has a switch for email-and-password sign-up and sign-in
 * (`SUPATYPE_EXTERNAL_EMAIL_ENABLED`), and nothing in supatype.config.ts reached it, so a project
 * that signs in only with OAuth or SAML could not turn the password form's endpoints off.
 * `auth.email.enabled` now renders it for the compose file (docker dev and self-host) and for
 * native dev, with a value in `.env` winning as it does for every other auth setting.
 */

const KEY = "SUPATYPE_EXTERNAL_EMAIL_ENABLED"
const BASE = { project: { name: "demo" }, server: { mode: "dev" }, app: { mode: "none" }, database: { provider: "docker" } }
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function config(enabled?: boolean): SupatypeProjectConfig {
  return validateProjectConfig(
    { ...BASE, ...(enabled !== undefined && { auth: { email: { enabled } } }) },
    "supatype.config.ts",
  )
}

/** What native dev starts the server with for the switch, `.env` given as `dotEnv`. */
function native(cfg: SupatypeProjectConfig, dotEnv: Record<string, string> = {}): string | undefined {
  const cwd = mkdtempSync(join(tmpdir(), "supatype-email-enabled-"))
  dirs.push(cwd)
  return nativeServerDotEnvLayer({ dotEnv, config: cfg, denoPort: 54330 })[KEY]
}

describe("auth.email.enabled", () => {
  it("leaves email sign-in on when the config does not say", () => {
    expect(renderSelfHostCompose(config())).toContain(`${KEY}: \${${KEY}:-true}`)
    expect(native(config())).toBe("true")
  })

  it("turns it off for self-host, docker dev and native dev", () => {
    expect(renderSelfHostCompose(config(false))).toContain(`${KEY}: \${${KEY}:-false}`)
    expect(renderSelfHostCompose(config(false), process.cwd(), { devLocal: true })).toContain(`${KEY}: \${${KEY}:-false}`)
    expect(native(config(false))).toBe("false")
  })

  it("lets a value in .env win, as every other auth setting does", () => {
    expect(native(config(false), { [KEY]: "true" })).toBe("true")
  })

  it("must be a boolean", () => {
    expect(() => validateProjectConfig({ ...BASE, auth: { email: { enabled: "no" } } }, "supatype.config.ts")).toThrow(
      /auth\.email\.enabled must be true or false/,
    )
  })
})
