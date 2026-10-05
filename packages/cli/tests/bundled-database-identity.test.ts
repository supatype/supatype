import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { seedMissingDatabaseIdentity, seedMissingLocalSecrets } from "../src/local-secrets.js"
import { unsupportedBundledDbUser } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"

/**
 * The database identity in `.env` belongs to the bundled Postgres only.
 *
 * Two failures this pins. A hand-written `POSTGRES_USER` other than supatype_admin left the db
 * container exiting on first start and `dev` waiting ninety seconds to say the database never became
 * healthy (edge-kit's template did exactly this). And `dev` wrote POSTGRES_USER and POSTGRES_DB into
 * the `.env` of a project on an external database, which has no use for either.
 */

function project(env?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-db-identity-"))
  if (env !== undefined) writeFileSync(join(dir, ".env"), env, "utf8")
  return dir
}

const base = {
  project: { name: "acme" },
  server: { mode: "dev" as const },
  app: { mode: "none" as const },
}
const bundled = (): SupatypeProjectConfig =>
  validateProjectConfig({ ...base, database: { provider: "docker" } }, "supatype.config.ts")
const external = (): SupatypeProjectConfig =>
  validateProjectConfig(
    { ...base, database: { external: { url: "postgres://owner:secret@db.example.com:5432/app" } } },
    "supatype.config.ts",
  )

describe("a POSTGRES_USER the bundled database cannot run as", () => {
  it("is reported before compose starts", () => {
    expect(unsupportedBundledDbUser(project("POSTGRES_USER=postgres\n"), bundled(), {})).toBe("postgres")
  })

  it("is not reported when unset, empty or supatype_admin", () => {
    expect(unsupportedBundledDbUser(project(), bundled(), {})).toBeUndefined()
    expect(unsupportedBundledDbUser(project("POSTGRES_USER=\n"), bundled(), {})).toBeUndefined()
    expect(unsupportedBundledDbUser(project("POSTGRES_USER=supatype_admin\n"), bundled(), {})).toBeUndefined()
  })

  // Compose reads the shell ahead of `.env`, so the check has to read the value compose will use.
  it("is read from the shell first, as Compose reads it", () => {
    const fineFile = project("POSTGRES_USER=supatype_admin\n")
    expect(unsupportedBundledDbUser(fineFile, bundled(), { POSTGRES_USER: "postgres" })).toBe("postgres")
    const badFile = project("POSTGRES_USER=postgres\n")
    expect(unsupportedBundledDbUser(badFile, bundled(), { POSTGRES_USER: "supatype_admin" })).toBeUndefined()
  })

  it("does not apply to an external database, whose URL names its own user", () => {
    expect(unsupportedBundledDbUser(project("POSTGRES_USER=owner\n"), external(), {})).toBeUndefined()
  })
})

describe("seeding the database identity", () => {
  it("fills what a bundled database needs and keeps what is there", () => {
    expect(seedMissingDatabaseIdentity(project(), bundled())).toEqual({
      POSTGRES_USER: "supatype_admin",
      POSTGRES_DB: "supatype",
    })
    expect(seedMissingDatabaseIdentity(project("POSTGRES_DB=shop\n"), bundled())).toEqual({
      POSTGRES_USER: "supatype_admin",
    })
  })

  it("writes nothing for an external database", () => {
    expect(seedMissingDatabaseIdentity(project(), external())).toEqual({})
  })

  // The external stack never reads it: every service connects with the operator's DATABASE_URL.
  it("seeds no Postgres password for an external database, and still the JWT secret", () => {
    const seeded = seedMissingLocalSecrets(project(), external())
    expect(seeded).not.toHaveProperty("POSTGRES_PASSWORD")
    expect(seeded).toHaveProperty("JWT_SECRET")
    expect(seedMissingLocalSecrets(project(), bundled())).toHaveProperty("POSTGRES_PASSWORD")
  })
})
