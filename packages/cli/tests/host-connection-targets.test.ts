import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveTarget } from "../src/resolve-target.js"
import { resolveHostEngineDatabaseUrl } from "../src/dev-compose.js"

/**
 * A command that runs the engine on the host has to reach the database at an address the host can
 * resolve.
 *
 * `supatype adopt` on a docker project failed looking up the host `db` (supatype#85): direct mode
 * took `.supatype/environment.json`'s URL, which describes the `db` *container*. `doctor` and
 * `pull` read `process.env` and never the project's `.env`, where `supatype dev` writes the
 * host-published URL. Every one now goes through the resolver seed already used.
 */

const CONTAINER_URL = "postgresql://supatype_admin:pw@db:5432/supatype?sslmode=disable"
const HOST_URL = "postgresql://supatype_admin:pw@localhost:54329/supatype?sslmode=disable"

let tmp: string
let previousDatabaseUrl: string | undefined

function dockerProject(dir: string): void {
  writeFileSync(
    join(dir, "supatype.config.ts"),
    `export default ${JSON.stringify({
      project: { name: "demo" },
      database: { provider: "docker" },
      server: { mode: "dev" },
      app: { mode: "none" },
      schema: { path: "schema/index.ts", pg_schema: "public" },
    })}`,
  )
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  // What `supatype dev` leaves behind: the container URL for containers, the host URL in `.env`.
  writeFileSync(
    join(dir, ".supatype", "environment.json"),
    JSON.stringify({
      target: "local",
      apiUrl: "http://127.0.0.1:18473",
      databaseUrl: CONTAINER_URL,
      projectRef: "demo",
      kongPort: 18473,
      provider: "docker",
    }),
  )
  writeFileSync(join(dir, ".env"), `DATABASE_URL=${HOST_URL}\n`)
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "supatype-host-db-"))
  previousDatabaseUrl = process.env["DATABASE_URL"]
  delete process.env["DATABASE_URL"]
  dockerProject(tmp)
})

afterEach(() => {
  if (previousDatabaseUrl === undefined) delete process.env["DATABASE_URL"]
  else process.env["DATABASE_URL"] = previousDatabaseUrl
  rmSync(tmp, { recursive: true, force: true })
})

describe("a host-side command on a docker project", () => {
  it("connects direct mode to the host-published database, not the container (#85)", () => {
    const target = resolveTarget(tmp, { direct: true })
    expect(target.databaseUrl).toBe(HOST_URL)
  })

  it("does the same for the local target used when there is no service key", () => {
    const target = resolveTarget(tmp)
    expect(target.mode).toBe("local")
    expect(target.databaseUrl).toBe(HOST_URL)
  })

  it("reads the project's .env for doctor and pull, not only the process environment", async () => {
    expect(await resolveHostEngineDatabaseUrl(tmp, (await import("../src/config.js")).loadConfig(tmp))).toBe(HOST_URL)
  })

  it("still takes --connection over everything", () => {
    const explicit = "postgresql://someone:else@example.test:5432/app"
    expect(resolveTarget(tmp, { direct: true, connection: explicit }).databaseUrl).toBe(explicit)
  })
})
