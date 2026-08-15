import { describe, it, expect } from "vitest"
import { loopbackExternalHost, renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * Compose for a database Supatype does not manage.
 *
 * The cheap test that pins the whole workstream: no `db` service, no `@db:5432` anywhere, and every
 * service resolving to the operator's URL. A stack that still names `db` starts six containers that
 * cannot resolve the host, which is a confusing way to learn the config was ignored.
 */
const EXTERNAL_URL = "postgres://owner:secret@db.example.com:5432/app"

const base = {
  project: { name: "acme" },
  server: { mode: "dev" as const },
  app: { mode: "none" as const },
  versions: {
    engine: "0.4.2",
    server: "0.1.0",
    postgres: "17.2",
    deno: DENO_RELEASE_PIN,
  },
}

const project = (database: unknown): SupatypeProjectConfig =>
  validateProjectConfig({ ...base, database }, "supatype.config.ts")

const external = (url = EXTERNAL_URL) => project({ external: { url } })
const managed = () => project({ provider: "docker" })

describe("external database — compose", () => {
  it("omits the db service and says why", () => {
    const compose = renderSelfHostCompose(external())
    expect(compose).not.toMatch(/^ {2}db:$/m)
    expect(compose).toContain("# No `db` service: database.external")
  })

  it("keeps the db service for a managed database", () => {
    // The gate must not cost everyone else their database.
    const compose = renderSelfHostCompose(managed())
    expect(compose).toMatch(/^ {2}db:$/m)
    expect(compose).toContain("pg_isready")
  })

  it("leaves no reference to the db host anywhere", () => {
    const compose = renderSelfHostCompose(external())
    expect(compose).not.toContain("@db:5432")
    expect(compose).not.toContain("db-data")
    expect(compose).not.toContain("condition: service_healthy")
  })

  it("points every database consumer at the one URL", () => {
    const compose = renderSelfHostCompose(external())
    // storage, realtime, control-plane, server (SUPATYPE_SQL_DATABASE_URL), and GoTrue.
    const references = compose.match(/\$\{DATABASE_URL:\?/g) ?? []
    expect(references.length).toBe(5)
  })

  it("interpolates the URL rather than baking the password into the file", () => {
    // The compose file is generated into .supatype/, which operators do commit.
    const compose = renderSelfHostCompose(external())
    // "secret" alone would match minio's own S3 credentials, so match the userinfo form.
    expect(compose).not.toContain("owner:secret@")
    expect(compose).not.toContain("://owner")
    expect(compose).toContain("${DATABASE_URL:?DATABASE_URL is missing from .env")
  })

  it("derives PostgREST's authenticator DSN from the URL, password excepted", () => {
    // A second full URL in .env would be one more thing to keep in step; two that disagree about
    // which database is a split-brain nobody notices until the API and migrations diverge.
    const compose = renderSelfHostCompose(external())
    expect(compose).toContain(
      "PGRST_DB_URI: postgresql://authenticator:${AUTHENTICATOR_PASSWORD:?AUTHENTICATOR_PASSWORD is missing from .env}@db.example.com:5432/app",
    )
  })

  it("carries the URL's query string into the authenticator DSN", () => {
    // `?sslmode=require` is the default on most managed providers, and dropping it turns a working
    // owner connection into a PostgREST that cannot connect at all.
    const compose = renderSelfHostCompose(
      external("postgres://owner:secret@db.example.com:5432/app?sslmode=require"),
    )
    expect(compose).toContain("@db.example.com:5432/app?sslmode=require")
  })

  it("appends GoTrue's search_path with the right separator", () => {
    // A URL that already has a query string needs `&`; a second `?` produces a DSN that fails to
    // parse, and GoTrue would exit rather than run its auth migrations.
    expect(renderSelfHostCompose(external())).toContain('${DATABASE_URL:?DATABASE_URL is missing from .env — required by database.external}?search_path=auth"')
    expect(
      renderSelfHostCompose(
        external("postgres://owner:secret@db.example.com:5432/app?sslmode=require"),
      ),
    ).toContain('${DATABASE_URL:?DATABASE_URL is missing from .env — required by database.external}&search_path=auth"')
  })

  it("omits realtime entirely when the project turns it off", () => {
    // For the operator who has read `supatype db check` and knows their database cannot do logical
    // decoding. The service degrades on its own, so this is about not running a container whose only
    // job would be to report that.
    const compose = renderSelfHostCompose(project({ external: { url: EXTERNAL_URL, realtime: false } }))
    expect(compose).not.toMatch(/^ {2}realtime:$/m)
    expect(compose).toContain("# No `realtime` service: database.external.realtime is false")
    // And nothing else may reference the service that is not there.
    expect(compose).not.toContain("SUPATYPE_REALTIME_URL")
    expect(compose).not.toContain("      realtime:\n        condition:")
  })

  it("keeps realtime when the flag is unset", () => {
    // Unset means "probe it", not "assume it is broken" — the service reports its own capability.
    const compose = renderSelfHostCompose(external())
    expect(compose).toMatch(/^ {2}realtime:$/m)
    expect(compose).toContain("SUPATYPE_REALTIME_URL: http://realtime:4000")
  })

  it("does not publish a port for a database it does not run", () => {
    const compose = renderSelfHostCompose(external())
    expect(compose).not.toContain('"5432:5432"')
  })

  it("still declares the volumes it does own", () => {
    const compose = renderSelfHostCompose(external())
    expect(compose).toContain("  minio-data:")
    expect(compose).toContain("  valkey-data:")
  })

  it("keeps the rest of the stack intact", () => {
    // The db service is the only thing that goes; a missing storage or realtime service would be a
    // far quieter failure than a missing database.
    const compose = renderSelfHostCompose(external())
    for (const service of [
      "postgrest:",
      "storage:",
      "functions-worker:",
      "realtime:",
      "control-plane:",
      "server:",
      "minio:",
      "schema-engine:",
      "studio:",
      "valkey:",
      "kong:",
    ]) {
      expect(compose).toContain(`  ${service}`)
    }
  })

  it("renders valid YAML shape for the server's remaining dependencies", () => {
    // The server waited on db *and* six others, so removing one entry must not leave a dangling
    // `depends_on:` or a stray blank mapping key.
    const compose = renderSelfHostCompose(external())
    expect(compose).toContain("    depends_on:\n      valkey:\n        condition: service_started")
  })
})

describe("a loopback external URL", () => {
  // Found by rehearsing a push against a real external Postgres: `db check` passed and `push`
  // applied the schema, because the CLI runs on the host — then storage, realtime and the server all
  // died with ECONNREFUSED against their own loopback, because inside a container `127.0.0.1` is
  // that container. A retry loop would only have hidden it.
  it("is detected, whatever form it takes", () => {
    for (const host of ["localhost", "127.0.0.1", "127.0.0.53", "[::1]"]) {
      const url = host.startsWith("[")
        ? `postgres://u:p@${host}:5432/d`
        : `postgres://u:p@${host}:5432/d`
      expect(loopbackExternalHost(project({ external: { url } })), host).toBeDefined()
    }
  })

  it("does not fire for a host containers can actually reach", () => {
    for (const host of ["host.docker.internal", "db.example.com", "172.17.0.1", "10.0.0.5"]) {
      expect(
        loopbackExternalHost(project({ external: { url: `postgres://u:p@${host}:5432/d` } })),
        host,
      ).toBeUndefined()
    }
  })

  it("does not fire for a managed database", () => {
    expect(loopbackExternalHost(managed())).toBeUndefined()
  })
})
