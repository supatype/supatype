import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * What a compose stack tells the server about where its database is reached from the host.
 *
 * Studio's connection strings are built from it. They used to be built from the API URL, so a
 * docker dev project was shown the gateway's port with the `postgres` login and the `postgres`
 * database, none of which that stack has. The port has to be the expression the `db` service's
 * `ports:` block binds, or the string and the mapping drift apart the first time one changes.
 */

const project = (over: Record<string, unknown> = {}): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      app: { mode: "none" },
      database: { provider: "docker" },
      versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
      ...over,
    },
    "supatype.config.ts",
  )

/**
 * The `server` service's value for `key`, as written into the compose file. Scoped to that service
 * because the `db` service carries some of the same names, `POSTGRES_PASSWORD` among them.
 */
function serverEnv(compose: string, key: string): string | undefined {
  const block = /^ {2}server:\n([\s\S]*?)(?=^ {2}\S)/m.exec(compose)?.[1] ?? ""
  const match = new RegExp(`^ {6}${key}: (.*)$`, "m").exec(block)
  return match?.[1]?.replace(/^"|"$/g, "")
}

/** The host side of the `db` service's port mapping, without its bind address. */
function dbPublishedPort(compose: string): string | undefined {
  return /- "(?:127\.0\.0\.1:|\$\{SUPATYPE_PUBLISH_ADDRESS:-127\.0\.0\.1\}:)?(\$\{SUPATYPE_(?:DEV_)?DB_PORT:-\d+\}):5432"/.exec(compose)?.[1]
}

describe("the database's host-side address, for Studio", () => {
  it("is loopback and the dev port in a docker dev stack", () => {
    const compose = renderSelfHostCompose(project({ server: { mode: "dev" } }), process.cwd(), { devLocal: true })
    expect(serverEnv(compose, "SUPATYPE_DB_PUBLIC_URL")).toBe(
      "postgresql://${POSTGRES_USER:-supatype_admin}@127.0.0.1:${SUPATYPE_DEV_DB_PORT:-54329}/${POSTGRES_DB:-supatype}",
    )
    expect(serverEnv(compose, "SUPATYPE_DB_PUBLIC_URL")).toContain(`:${dbPublishedPort(compose)}/`)
  })

  it("is the self-host port, at a host .env can override, in a self-host stack", () => {
    const compose = renderSelfHostCompose(project({ server: { mode: "standalone" } }))
    expect(serverEnv(compose, "SUPATYPE_DB_PUBLIC_URL")).toBe(
      "postgresql://${POSTGRES_USER:-supatype_admin}@${SUPATYPE_DB_PUBLIC_HOST:-127.0.0.1}:${SUPATYPE_DB_PORT:-5432}/${POSTGRES_DB:-supatype}",
    )
    expect(serverEnv(compose, "SUPATYPE_DB_PUBLIC_URL")).toContain(`:${dbPublishedPort(compose)}/`)
  })

  it("defaults to the configured domain, where an operator who exposes the database reaches it", () => {
    const compose = renderSelfHostCompose(project({ server: { mode: "standalone", domain: "api.example.com" } }))
    expect(serverEnv(compose, "SUPATYPE_DB_PUBLIC_URL")).toContain("@${SUPATYPE_DB_PUBLIC_HOST:-api.example.com}:")
  })

  it("is the operator's own URL for an external database, which the server strips of its password", () => {
    const compose = renderSelfHostCompose(
      project({ server: { mode: "standalone" }, database: { external: { url: "postgres://o:secret@pg.example.com/app" } } }),
    )
    expect(serverEnv(compose, "SUPATYPE_DB_PUBLIC_URL")).toBe(
      "${DATABASE_URL:?DATABASE_URL is missing from .env, required by database.external}",
    )
    expect(compose).not.toContain("o:secret@")
    // The bundled password does not exist here, and requiring it would refuse to start the stack.
    expect(serverEnv(compose, "POSTGRES_PASSWORD")).toBeUndefined()
  })

  it("declares no pooler unless .env names one, because self-host ships none", () => {
    const compose = renderSelfHostCompose(project({ server: { mode: "standalone" } }))
    expect(serverEnv(compose, "SUPATYPE_DB_POOLER_URL")).toBe("${SUPATYPE_DB_POOLER_URL:-}")
    expect(compose).not.toContain("pgbouncer")
  })

  it("gives the server the stack's own password, so Studio's View Password is not a guess", () => {
    // Without it the server answered its fallback, `postgres`, whatever the stack was created with.
    const compose = renderSelfHostCompose(project({ server: { mode: "dev" } }), process.cwd(), { devLocal: true })
    expect(serverEnv(compose, "POSTGRES_PASSWORD")).toBe("${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is missing from .env}")
  })
})
