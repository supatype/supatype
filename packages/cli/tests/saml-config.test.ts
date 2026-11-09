import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createPrivateKey } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { renderSelfHostCompose, writeSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { nativeSamlEnv } from "../src/saml-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * SAML single sign-on from `auth.sso.saml` in supatype.config.ts.
 *
 * The auth server has a whole SAML service provider, switched on by `SUPATYPE_SAML_*` variables
 * that nothing in the CLI set, so no project could use it. The signing key is a secret and has to
 * stay the same across restarts: every IdP that trusts the SP's certificate breaks when it changes.
 */

function config(auth?: unknown): SupatypeProjectConfig {
  return validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "dev" as const },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
      ...(auth !== undefined && { auth }),
    },
    "supatype.config.ts",
  )
}

const saml = (extra: Record<string, unknown> = {}) => ({ sso: { saml: { enabled: true, ...extra } } })

/** The server service's environment, as `KEY: value` pairs. */
function serverEnv(compose: string): Map<string, string> {
  const block = /^ {2}server:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(compose)?.[1] ?? ""
  const out = new Map<string, string>()
  for (const line of block.split("\n")) {
    const match = /^\s{6}([A-Z_]+):\s*(.*)$/.exec(line)
    if (match?.[1] !== undefined) out.set(match[1], (match[2] ?? "").replace(/^"|"$/g, ""))
  }
  return out
}

describe("auth.sso.saml validation", () => {
  it("accepts every field it documents", () => {
    expect(() =>
      config(
        saml({
          allowEncryptedAssertions: true,
          relayStateValidity: 300,
          rateLimitAssertion: 30,
          externalUrl: "https://api.example.com/auth/v1",
        }),
      ),
    ).not.toThrow()
  })

  it("refuses an unknown field, naming the known ones", () => {
    expect(() => config(saml({ relayState: 300 }))).toThrow(/auth\.sso\.saml has unknown field\(s\) relayState/)
  })

  it("refuses a private key written into the config, pointing at .env", () => {
    expect(() => config(saml({ privateKey: "MIIEow..." }))).toThrow(/auth\.sso\.saml\.privateKey.*SUPATYPE_SAML_PRIVATE_KEY.*\.env/s)
  })

  it("refuses an unknown key under auth.sso", () => {
    expect(() => config({ sso: { oidc: {} } })).toThrow(/auth\.sso has unknown field\(s\) oidc/)
  })

  it("requires enabled to be a boolean", () => {
    expect(() => config({ sso: { saml: {} } })).toThrow(/auth\.sso\.saml\.enabled must be true or false/)
    expect(() => config({ sso: { saml: { enabled: "true" } } })).toThrow(/auth\.sso\.saml\.enabled must be true or false/)
  })

  it("takes the relay state validity in whole seconds, as the config's other durations", () => {
    expect(() => config(saml({ relayStateValidity: "2m" }))).toThrow(/relayStateValidity must be a whole number of seconds/)
    expect(() => config(saml({ relayStateValidity: 0 }))).toThrow(/relayStateValidity/)
  })

  it("refuses a rate limit that is not a positive number", () => {
    expect(() => config(saml({ rateLimitAssertion: -1 }))).toThrow(/rateLimitAssertion/)
  })

  it("refuses an external URL that is not http(s) or would break the compose line", () => {
    expect(() => config(saml({ externalUrl: "ftp://x" }))).toThrow(/auth\.sso\.saml\.externalUrl/)
    expect(() => config(saml({ externalUrl: "https://a.com/${X}" }))).toThrow(/auth\.sso\.saml\.externalUrl/)
  })
})

describe("auth.sso.saml in the compose stack", () => {
  it("renders nothing for a project that has not turned SAML on", () => {
    expect(renderSelfHostCompose(config())).not.toContain("SUPATYPE_SAML_")
    expect(renderSelfHostCompose(config({ sso: { saml: { enabled: false } } }))).not.toContain("SUPATYPE_SAML_")
  })

  for (const devLocal of [false, true]) {
    it(`requires the key from .env and never writes a value (devLocal ${devLocal})`, () => {
      const vars = serverEnv(renderSelfHostCompose(config(saml()), undefined, { devLocal }))
      expect(vars.get("SUPATYPE_SAML_ENABLED")).toBe("${SUPATYPE_SAML_ENABLED:-true}")
      expect(vars.get("SUPATYPE_SAML_PRIVATE_KEY")).toBe(
        "${SUPATYPE_SAML_PRIVATE_KEY:?SUPATYPE_SAML_PRIVATE_KEY is missing from .env}",
      )
      expect(vars.get("SUPATYPE_SAML_NEXT_PRIVATE_KEY")).toBe("${SUPATYPE_SAML_NEXT_PRIVATE_KEY:-}")
    })
  }

  it("puts the service provider under the gateway's /auth/v1, where the server's routes are", () => {
    const vars = serverEnv(renderSelfHostCompose(config(saml())))
    expect(vars.get("SUPATYPE_SAML_EXTERNAL_URL")).toBe(
      "${SUPATYPE_SAML_EXTERNAL_URL:-${API_EXTERNAL_URL:-http://localhost:${SUPATYPE_KONG_PORT:-18473}}/auth/v1}",
    )
  })

  it("passes the optional settings, each overridable from .env", () => {
    const vars = serverEnv(
      renderSelfHostCompose(
        config(
          saml({
            allowEncryptedAssertions: true,
            relayStateValidity: 300,
            rateLimitAssertion: 30,
            externalUrl: "https://sso.example.com/auth/v1",
          }),
        ),
      ),
    )
    expect(vars.get("SUPATYPE_SAML_ALLOW_ENCRYPTED_ASSERTIONS")).toBe("${SUPATYPE_SAML_ALLOW_ENCRYPTED_ASSERTIONS:-true}")
    expect(vars.get("SUPATYPE_SAML_RELAY_STATE_VALIDITY_PERIOD")).toBe("${SUPATYPE_SAML_RELAY_STATE_VALIDITY_PERIOD:-300s}")
    expect(vars.get("SUPATYPE_SAML_RATE_LIMIT_ASSERTION")).toBe("${SUPATYPE_SAML_RATE_LIMIT_ASSERTION:-30}")
    expect(vars.get("SUPATYPE_SAML_EXTERNAL_URL")).toBe("${SUPATYPE_SAML_EXTERNAL_URL:-https://sso.example.com/auth/v1}")
  })
})

describe("the SAML signing key", () => {
  let dir = ""
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-saml-"))
    writeFileSync(join(dir, ".env"), "JWT_SECRET=kept\n", "utf8")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const readEnv = (): string => readFileSync(join(dir, ".env"), "utf8")
  const keyIn = (env: string): string | undefined => /^SUPATYPE_SAML_PRIVATE_KEY=(.+)$/m.exec(env)?.[1]

  it("is generated into .env as the server requires it: base64 PKCS#1 DER, RSA 2048, e=65537", () => {
    writeSelfHostCompose(dir, config(saml()))
    const key = createPrivateKey({ key: Buffer.from(keyIn(readEnv()) ?? "", "base64"), format: "der", type: "pkcs1" })
    expect(key.asymmetricKeyType).toBe("rsa")
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048)
    expect(key.asymmetricKeyDetails?.publicExponent).toBe(65537n)
  })

  it("is never regenerated, so the SP certificate IdPs trust stays the same", () => {
    writeSelfHostCompose(dir, config(saml()))
    const first = readEnv()
    writeSelfHostCompose(dir, config(saml()))
    expect(readEnv()).toBe(first)
    expect(nativeSamlEnv(dir, config(saml()))["SUPATYPE_SAML_PRIVATE_KEY"]).toBe(keyIn(first))
    expect(readEnv()).toBe(first)
  })

  it("keeps a key the project already has", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=kept\nSUPATYPE_SAML_PRIVATE_KEY=operator-key\n", "utf8")
    writeSelfHostCompose(dir, config(saml()))
    expect(keyIn(readEnv())).toBe("operator-key")
  })

  it("is not generated while SAML is off", () => {
    writeSelfHostCompose(dir, config())
    expect(readEnv()).not.toContain("SUPATYPE_SAML_")
    expect(nativeSamlEnv(dir, config({ sso: { saml: { enabled: false } } }))).toEqual({})
    expect(readEnv()).not.toContain("SUPATYPE_SAML_")
  })
})

describe("auth.sso.saml in native dev", () => {
  let dir = ""
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-saml-native-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("hands the server the settings, the key and the next key from .env", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_SAML_PRIVATE_KEY=current\nSUPATYPE_SAML_NEXT_PRIVATE_KEY=next\n", "utf8")
    expect(nativeSamlEnv(dir, config(saml({ relayStateValidity: 90, rateLimitAssertion: 5 })))).toEqual({
      SUPATYPE_SAML_ENABLED: "true",
      SUPATYPE_SAML_RELAY_STATE_VALIDITY_PERIOD: "90s",
      SUPATYPE_SAML_RATE_LIMIT_ASSERTION: "5",
      SUPATYPE_SAML_PRIVATE_KEY: "current",
      SUPATYPE_SAML_NEXT_PRIVATE_KEY: "next",
    })
  })

  it("generates the key on the first native start with SAML on", () => {
    const vars = nativeSamlEnv(dir, config(saml()))
    expect(vars["SUPATYPE_SAML_PRIVATE_KEY"]?.length ?? 0).toBeGreaterThan(1000)
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(`SUPATYPE_SAML_PRIVATE_KEY=${vars["SUPATYPE_SAML_PRIVATE_KEY"]}`)
    expect(vars).not.toHaveProperty("SUPATYPE_SAML_NEXT_PRIVATE_KEY")
  })
})
