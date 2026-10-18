import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { upsertDevComposeEnv } from "../src/dev-compose.js"
import { ensureDevDbPort } from "../src/dev-ports.js"
import { readEnvValue } from "../src/env-file.js"
import { isPortInUse } from "../src/postgres-ctl.js"
import { validateProjectConfig } from "../src/project-config.js"

vi.mock("../src/postgres-ctl.js", () => ({
  isPortInUse: vi.fn(),
}))

/**
 * DR9: a port given only in the shell for one run (`SUPATYPE_KONG_PORT=18990 supatype dev`) was
 * written into `.env`, so the throwaway port became the project's port for every later run. A
 * shell-only port is now treated like `SUPATYPE_PROJECT_NAME`: the run uses it, `.env` keeps its own.
 */

const config = validateProjectConfig(
  { project: { name: "demo" }, server: { mode: "dev" }, app: { mode: "none" }, database: { provider: "docker" } },
  "supatype.config.ts",
)
const dirs: string[] = []

/** Every key the run may set in this process's environment, cleared so no test inherits another's. */
const RUN_KEYS = [
  "SUPATYPE_KONG_PORT",
  "API_EXTERNAL_URL",
  "SITE_URL",
  "VITE_SUPATYPE_URL",
  "PUBLIC_SUPATYPE_URL",
  "EXPO_PUBLIC_SUPATYPE_URL",
  "SUPATYPE_DEV_DB_PORT",
  "DATABASE_URL",
]

beforeEach(() => {
  for (const key of RUN_KEYS) vi.stubEnv(key, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PERSISTED = [
  "SUPATYPE_KONG_PORT=18474",
  "API_EXTERNAL_URL=http://localhost:18474",
  "SITE_URL=http://localhost:18474",
  "VITE_SUPATYPE_URL=http://localhost:18474",
  "SUPATYPE_DEV_DB_PORT=54329",
  "DATABASE_URL=postgresql://demo:pw@localhost:54329/demo",
]

/** A project whose `.env` already holds its own ports. */
function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "supatype-shell-ports-"))
  dirs.push(cwd)
  writeFileSync(join(cwd, ".env"), `JWT_SECRET=x\nPOSTGRES_PASSWORD=pw\n${PERSISTED.join("\n")}\n`, "utf8")
  return cwd
}

const env = (cwd: string, key: string): string => readEnvValue(cwd, key, "<unset>")

describe("a dev port given only in the shell", () => {
  it("leaves the Kong port and the URLs built from it in .env as they were", () => {
    const cwd = project()
    vi.stubEnv("SUPATYPE_KONG_PORT", "18990")
    upsertDevComposeEnv(cwd, config, "anon-key", "service-key", 18990)
    expect(env(cwd, "SUPATYPE_KONG_PORT")).toBe("18474")
    expect(env(cwd, "API_EXTERNAL_URL")).toBe("http://localhost:18474")
    expect(env(cwd, "SITE_URL")).toBe("http://localhost:18474")
    expect(env(cwd, "VITE_SUPATYPE_URL")).toBe("http://localhost:18474")
    // The run itself still uses the shell's port: compose and the app inherit this environment.
    expect(process.env["API_EXTERNAL_URL"]).toBe("http://localhost:18990")
    // What is not built from the port is still written.
    expect(env(cwd, "ANON_KEY")).toBe("anon-key")
  })

  it("leaves the database port and DATABASE_URL in .env as they were", () => {
    const cwd = project()
    vi.stubEnv("SUPATYPE_DEV_DB_PORT", "55999")
    upsertDevComposeEnv(cwd, config, "anon-key", "service-key", 18474, 55999)
    expect(env(cwd, "SUPATYPE_DEV_DB_PORT")).toBe("54329")
    expect(env(cwd, "DATABASE_URL")).toBe("postgresql://demo:pw@localhost:54329/demo")
    expect(process.env["DATABASE_URL"]).toContain(":55999/")
  })

  it("leaves a DATABASE_URL the shell sets alone", () => {
    const cwd = project()
    vi.stubEnv("SUPATYPE_DEV_DB_PORT", "55999")
    vi.stubEnv("DATABASE_URL", "postgresql://mine@localhost:55999/mine")
    upsertDevComposeEnv(cwd, config, "anon-key", "service-key", 18474, 55999)
    expect(process.env["DATABASE_URL"]).toBe("postgresql://mine@localhost:55999/mine")
  })

  it("is not moved, and not written, when it is busy", async () => {
    const cwd = project()
    vi.stubEnv("SUPATYPE_DEV_DB_PORT", "55999")
    vi.mocked(isPortInUse).mockResolvedValue(true)
    await expect(ensureDevDbPort(cwd, { mayMove: true })).rejects.toThrow(
      "SUPATYPE_DEV_DB_PORT=55999 is set in your shell",
    )
    expect(readFileSync(join(cwd, ".env"), "utf8")).toContain("SUPATYPE_DEV_DB_PORT=54329\n")
  })

  it("still writes a port that came from no shell", () => {
    const cwd = project()
    upsertDevComposeEnv(cwd, config, "anon-key", "service-key", 18500)
    expect(env(cwd, "SUPATYPE_KONG_PORT")).toBe("18500")
    expect(env(cwd, "API_EXTERNAL_URL")).toBe("http://localhost:18500")
  })
})
