import { describe, expect, it } from "vitest"
import { publishesDbToHost, renderSelfHostCompose } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * What compose publishes and what `DATABASE_URL` says have to be one decision.
 *
 * They came apart once. Publishing the database to the host was made unconditional, because
 * seeding is a host process and a database nothing on the host can reach is a database no seed
 * can use. The code that writes `DATABASE_URL` kept an older condition, `overrides.engine`, so a
 * project without a local engine build got a database published on 54329 and a `DATABASE_URL`
 * still pointing at 5432. `supatype seed` timed out and advised checking that the stack was
 * running, which it was.
 *
 * Every project this was tested against had an engine override, because that is how a contributor
 * points at a local build. The first project without one found it.
 */

const base: SupatypeProjectConfig = {
  project: { name: "conformance" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54321 },
  app: { mode: "static", static_dir: "./dist" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
} as SupatypeProjectConfig

const withEngineOverride = {
  ...base,
  overrides: { engine: "/tmp/supatype-engine" },
} as SupatypeProjectConfig

const externalDatabase = {
  ...base,
  // An external database is stated by `external.url`, with no provider: there is no backend
  // for Supatype to choose when it does not manage the database.
  database: { external: { url: "postgresql://ops@db.example.com/app" } },
} as SupatypeProjectConfig

/** Whether the rendered compose file binds the `db` container to a host port. */
function composePublishesDb(config: SupatypeProjectConfig): boolean {
  return renderSelfHostCompose(config, process.cwd(), { devLocal: true }).includes(
    "SUPATYPE_DEV_DB_PORT:-54329}:5432",
  )
}

describe("the database is published and addressable, or neither", () => {
  it("renders a host port binding for a project with no local engine build", () => {
    // Asserted on the rendered compose file, not on the predicate. Comparing the predicate to the
    // compose render would be comparing the function to itself now that the render consults it,
    // and such a test passes however wrong the answer is.
    expect(composePublishesDb(base)).toBe(true)
    expect(composePublishesDb(withEngineOverride)).toBe(true)
  })

  it("renders no host port binding for an external database", () => {
    expect(composePublishesDb(externalDatabase)).toBe(false)
  })

  it("publishes for a project with no local engine build, which is most of them", () => {
    expect(publishesDbToHost(base)).toBe(true)
  })

  it("never publishes for an external database, whose URL belongs to the operator", () => {
    // Writing that URL once clobbered a real external Postgres. The exception is the whole reason
    // this is a predicate rather than a constant.
    expect(publishesDbToHost(externalDatabase)).toBe(false)
  })
})
