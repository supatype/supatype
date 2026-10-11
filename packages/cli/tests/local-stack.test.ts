import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * A3-N4, A4-N2: `push --connection` provisioned storage against `http://localhost:18473` and printed
 * a Studio link there for every docker project, which on a machine running another project is that
 * project's gateway. The address now comes from the project, and only for its own database.
 */
const dockerPs = vi.hoisted(() => ({ owner: "" }))
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[]) =>
    cmd === "docker" && args[0] === "ps" ? { status: 0, stdout: dockerPs.owner, stderr: "" } : { status: 1, stdout: "", stderr: "" },
}))

const { isProjectDatabase, projectStackUrl } = await import("../src/local-stack.js")
const { serverBaseUrl } = await import("../src/project-config.js")

const docker = { project: { name: "demo" }, provider: "docker", database: { provider: "docker" }, server: { mode: "dev" } } as SupatypeProjectConfig
const OWN = "postgresql://supatype_admin:pw@127.0.0.1:54880/demo?sslmode=disable"
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-local-stack-"))
  writeFileSync(join(dir, ".env"), "SUPATYPE_KONG_PORT=18880\nSUPATYPE_DEV_DB_PORT=54880\nPOSTGRES_DB=demo\n")
  dockerPs.owner = "supatype-demo\n"
  delete process.env["SUPATYPE_KONG_PORT"]
  delete process.env["SUPATYPE_DEV_DB_PORT"]
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("projectStackUrl", () => {
  it("is the project's own gateway for its own database", () => {
    expect(projectStackUrl(dir, docker, OWN)).toBe("http://localhost:18880")
    expect(projectStackUrl(dir, docker, undefined)).toBe("http://localhost:18880")
  })

  it("is nothing for a database the project does not run", () => {
    expect(projectStackUrl(dir, docker, "postgresql://postgres:x@127.0.0.1:56480/postgres")).toBeUndefined()
    expect(projectStackUrl(dir, docker, "postgresql://u:p@db.example.com:5432/demo")).toBeUndefined()
  })

  it("is nothing when the gateway port belongs to another project", () => {
    dockerPs.owner = "supatype-someone-else\n"
    expect(projectStackUrl(dir, docker, OWN)).toBeUndefined()
  })

  it("is nothing when no gateway port was ever recorded", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_DEV_DB_PORT=54880\nPOSTGRES_DB=demo\n")
    expect(projectStackUrl(dir, docker, OWN)).toBeUndefined()
  })
})

describe("isProjectDatabase", () => {
  it("is false for an external database, whatever the URL", () => {
    const external = { ...docker, database: { external: { url: OWN } } } as SupatypeProjectConfig
    expect(isProjectDatabase(dir, external, OWN)).toBe(false)
  })
})

describe("serverBaseUrl for a docker project", () => {
  it("is the project's Kong port, not the default 18473", () => {
    expect(serverBaseUrl(docker, dir)).toBe("http://localhost:18880")
  })
})
