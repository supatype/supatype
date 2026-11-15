import { describe, it, expect } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * The `db` service runs an init as PID 1.
 *
 * Without one, postgres is PID 1 and adopts every orphan in the container. A health check that
 * Docker times out leaves an orphaned `pg_isready` that exits 2, and Postgres 17 treats an unknown
 * child exiting non-0/1 as a crashed backend and restarts the whole server. `init: true` puts
 * Docker's own tini in front so the orphan is reaped instead. One renderer writes the compose file
 * for `supatype dev` and for self-host, so both modes are pinned here.
 */
const config = (mode: "dev" | "standalone", database: unknown): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: mode === "standalone" ? { mode, domain: "example.com" } : { mode },
      app: { mode: "none" as const },
      versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
      database,
    },
    "supatype.config.ts",
  )

/** The `db` service's own lines, from `  db:` up to the next two-space-indented key. */
function dbService(compose: string): string {
  const match = /^ {2}db:\n((?: {4,}.*\n|\n)*)/m.exec(compose)
  if (!match) throw new Error("no db service in the rendered compose")
  return match[1] ?? ""
}

describe("db service init", () => {
  for (const mode of ["dev", "standalone"] as const) {
    it(`runs an init as PID 1 in ${mode} mode`, () => {
      expect(dbService(renderSelfHostCompose(config(mode, { provider: "docker" })))).toMatch(/^ {4}init: true$/m)
    })
  }

  it("probes in exec form with pg_isready's own timeout under compose's", () => {
    // Shell form forks pg_isready under sh. When compose times a check out it kills the sh and
    // orphans pg_isready, which the init has to reap; exec form leaves no shell to kill, and -t
    // makes pg_isready give up before compose does.
    const db = dbService(renderSelfHostCompose(config("dev", { provider: "docker" })))
    expect(db).not.toContain("CMD-SHELL")
    const test = /^ {6}test: (\[.*\])$/m.exec(db)?.[1]
    expect(test).toBeDefined()
    const argv: unknown = JSON.parse(test ?? "[]")
    expect(argv).toEqual([
      "CMD", "pg_isready", "-h", "127.0.0.1",
      "-U", "${POSTGRES_USER:-supatype_admin}", "-d", "${POSTGRES_DB:-supatype}", "-t", "2",
    ])
    expect(db).toMatch(/^ {6}timeout: 5s$/m)
  })
})
