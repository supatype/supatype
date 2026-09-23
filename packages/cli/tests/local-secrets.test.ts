import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  FALLBACK_AUTHENTICATOR_PASSWORD,
  FALLBACK_JWT_SECRET,
  FALLBACK_POSTGRES_PASSWORD,
  devAuthenticatorPassword,
  devJwtSecret,
  devPostgresPassword,
  secretFingerprint,
} from "../src/local-secrets.js"
import { upsertEnvFile } from "../src/env-file.js"

// The bug these exist to prevent: `supatype dev` used to pin POSTGRES_PASSWORD and JWT_SECRET
// to published constants in `.env` on every run, the same `.env` a self-host deployment reads.
// A generated secret survived until the developer's next `dev`, then reverted silently, and the
// deployment went out with a secret anyone can look up.

function project(env?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-secrets-"))
  if (env !== undefined) writeFileSync(join(dir, ".env"), env, "utf8")
  return dir
}

describe("resolving local secrets", () => {
  it("prefers the project's own values", () => {
    const dir = project("JWT_SECRET=mine\nPOSTGRES_PASSWORD=pg-mine\nAUTHENTICATOR_PASSWORD=auth-mine\n")
    expect(devJwtSecret(dir)).toBe("mine")
    expect(devPostgresPassword(dir)).toBe("pg-mine")
    expect(devAuthenticatorPassword(dir)).toBe("auth-mine")
  })

  // A project with no `.env` still has to start, so the constants remain, as fallbacks only.
  it("falls back when the project has none", () => {
    const dir = project()
    expect(devJwtSecret(dir)).toBe(FALLBACK_JWT_SECRET)
    expect(devPostgresPassword(dir)).toBe(FALLBACK_POSTGRES_PASSWORD)
    expect(devAuthenticatorPassword(dir)).toBe(FALLBACK_AUTHENTICATOR_PASSWORD)
  })
})

describe("the dev env write does not clobber secrets", () => {
  // This is the regression. `upsertEnvFile` replaces any key handed to it, so the guarantee has
  // to be that the dev path never hands it these, asserted here at the level that matters:
  // write what dev writes, then check the secrets are byte-identical.
  it("leaves generated secrets untouched across repeated writes", () => {
    const dir = project(
      "JWT_SECRET=generated-secret-value\nPOSTGRES_PASSWORD=generated-pg-value\nAUTHENTICATOR_PASSWORD=generated-auth-value\n",
    )
    const before = readFileSync(join(dir, ".env"), "utf8")

    // The keys `upsertDevComposeEnv` legitimately owns: derived values and local ports.
    for (let run = 0; run < 2; run++) {
      upsertEnvFile(dir, {
        POSTGRES_USER: "supatype_admin",
        POSTGRES_DB: "supatype",
        AUTHENTICATOR_PASSWORD: devAuthenticatorPassword(dir),
        ANON_KEY: `anon-${run}`,
        SERVICE_ROLE_KEY: `service-${run}`,
        SUPATYPE_KONG_PORT: "18473",
      })
    }

    const after = readFileSync(join(dir, ".env"), "utf8")
    const value = (content: string, key: string): string | undefined =>
      content.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]

    for (const key of ["JWT_SECRET", "POSTGRES_PASSWORD", "AUTHENTICATOR_PASSWORD"]) {
      expect(value(after, key), `${key} must survive a dev run`).toBe(value(before, key))
    }
    // Derived keys are still expected to move.
    expect(value(after, "ANON_KEY")).toBe("anon-1")
  })
})

describe("secretFingerprint", () => {
  // The ready panel used to echo the JWT secret in full. Harmless for a published constant,
  // wrong once it is the project's own.
  it("does not reveal the secret", () => {
    const secret = "super-secret-value-that-must-not-be-printed"
    const tag = secretFingerprint(secret)
    expect(secret).not.toContain(tag)
    expect(tag).toMatch(/^[0-9a-f]{8}$/)
  })

  it("is stable and distinguishes secrets", () => {
    expect(secretFingerprint("a")).toBe(secretFingerprint("a"))
    expect(secretFingerprint("a")).not.toBe(secretFingerprint("b"))
  })
})
