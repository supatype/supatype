import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { upsertDevComposeEnv } from "../src/dev-compose.js"
import { ensureDevDbPort } from "../src/dev-ports.js"
import { offerToSaveShellDbPort } from "../src/db-port-offer.js"
import { warnIfHandWrittenUrlSilent } from "../src/database-url-owner.js"
import { envValueOwner } from "../src/env-file.js"
import { validateProjectConfig } from "../src/project-config.js"

/**
 * N1, Docker half: Docker dev rewrote DATABASE_URL in `.env` on every run, so a URL a person wrote
 * for their own Postgres was replaced by the stack's. The rule is now the native one: the CLI
 * rewrites only a URL it wrote (marked, or exactly the shape `init` writes); a hand-written one
 * always wins, with a warning when nothing answers where it points.
 */
const HAND_WRITTEN = "postgresql://me:secret@127.0.0.1:1/mine"
const INIT_URL = "postgresql://supatype_admin:pw@localhost:5432/acme"
let dir = ""

const docker = validateProjectConfig(
  { project: { name: "acme" }, server: { mode: "dev" }, app: { mode: "none" }, database: { provider: "docker" } },
  "supatype.config.ts",
)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-db-url-docker-"))
  for (const key of ["DATABASE_URL", "SUPATYPE_DEV_DB_PORT", "SUPATYPE_KONG_PORT"]) vi.stubEnv(key, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function writeEnv(url: string, extra: string[] = []): void {
  writeFileSync(join(dir, ".env"), [`DATABASE_URL=${url}`, "POSTGRES_PASSWORD=pw", "POSTGRES_DB=acme", "JWT_SECRET=x", ...extra, ""].join("\n"), "utf8")
}

const envUrl = (): string | undefined => /^DATABASE_URL=(.*)$/m.exec(readFileSync(join(dir, ".env"), "utf8"))?.[1]

describe("Docker dev and a DATABASE_URL in .env", () => {
  it("leaves a hand-written URL alone", () => {
    writeEnv(HAND_WRITTEN)
    upsertDevComposeEnv(dir, docker, "anon", "service", 18474, 54333)
    expect(envUrl()).toBe(HAND_WRITTEN)
  })

  it("still moves a URL init wrote to the stack, marked", () => {
    writeEnv(INIT_URL)
    upsertDevComposeEnv(dir, docker, "anon", "service", 18474, 54333)
    expect(envUrl()).toContain("127.0.0.1:54333/acme")
    expect(envValueOwner(dir, "DATABASE_URL")).toBe("cli")
  })

  it("does not write a hand-written URL over when it picks the dev port", async () => {
    writeEnv(HAND_WRITTEN)
    await ensureDevDbPort(dir)
    expect(envUrl()).toBe(HAND_WRITTEN)
  })

  it("offers nothing to save over a hand-written URL", async () => {
    writeEnv(HAND_WRITTEN.replace("127.0.0.1:1", "localhost:5432"))
    const asked: string[] = []
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    await offerToSaveShellDbPort(dir, { interactive: () => true, confirm: async (q) => (asked.push(q), true) }, { SUPATYPE_DEV_DB_PORT: "54339" })
    expect(asked).toEqual([])
    expect(envUrl()).toContain("localhost:5432/mine")
  })

  it("warns, without the password, when nothing answers at a hand-written URL", async () => {
    writeEnv(HAND_WRITTEN)
    const said: string[] = []
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    await warnIfHandWrittenUrlSilent(dir)
    expect(said.join("\n")).toMatch(/names 127\.0\.0\.1:1, and nothing answers there/)
    expect(said.join("\n")).not.toContain("secret")
  })
})
