import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * SH1: `supatype push` against a stack started with `self-host compose up` rendered the compose file
 * as a dev stack and recreated it that way: every origin allowed by CORS, Studio open without a login,
 * the database moved to a loopback dev port. It also wrote dev values over the operator's `.env`
 * (SITE_URL, SUPATYPE_MAILER_AUTOCONFIRM=true, a dev DATABASE_URL). The mode is now read from the stack:
 * dev while a `supatype dev` session holds the lock, else the running server's own mode, else
 * standalone.
 */

/** What `docker` answers: the server container of the project, and the mode it runs in. */
const docker = vi.hoisted(() => ({ serverMode: undefined as "dev" | "standalone" | undefined, calls: [] as string[][] }))
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const fake = (command: string, args: readonly string[] = []) => {
    if (command !== "docker") return { status: 0, stdout: "", stderr: "" }
    docker.calls.push([...args])
    const running = docker.serverMode !== undefined
    if (args[0] === "ps") return { status: 0, stdout: running ? "c0ffee\n" : "", stderr: "" }
    if (args[0] === "inspect") return { status: running ? 0 : 1, stdout: `PATH=/bin\nSUPATYPE_MODE=${docker.serverMode}\n`, stderr: "" }
    return { status: 0, stdout: "", stderr: "" }
  }
  return { ...actual, spawnSync: fake }
})

const ensureDevDbPort = vi.hoisted(() => vi.fn(async () => 54329))
vi.mock("../src/dev-ports.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev-ports.js")>()),
  ensureKongPort: async () => 55560,
  ensureDevDbPort,
}))

/** The options the push rendered with; the push stops right there, which is all this asks about. */
const rendered = vi.hoisted(() => ({ options: [] as Array<{ devLocal?: boolean } | undefined> }))
vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: (_cwd: string, _config: unknown, options?: { devLocal?: boolean }) => {
    rendered.options.push(options)
    throw new Error("rendered")
  },
}))

const { composeGatewayHostPort, pushSchemaDocker } = await import("../src/dev-compose.js")
const { composeRenderMode } = await import("../src/compose-render-mode.js")

const config: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "standalone" },
  app: { mode: "none" },
}

const OPERATOR_ENV = [
  "JWT_SECRET=an-operator-secret-that-is-at-least-32-characters",
  "POSTGRES_PASSWORD=operator-password",
  "SITE_URL=https://app.example.com",
  "API_EXTERNAL_URL=https://api.example.com",
  "SUPATYPE_MAILER_AUTOCONFIRM=false",
  "SUPATYPE_KONG_PORT=55560",
  "DATABASE_URL=postgresql://supatype_admin:operator-password@localhost:5432/acme",
  "",
].join("\n")

let cwd = ""

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-render-mode-"))
  writeFileSync(join(cwd, ".env"), OPERATOR_ENV)
  docker.serverMode = undefined
  docker.calls.length = 0
  rendered.options.length = 0
  ensureDevDbPort.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

function holdDevLock(): void {
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  writeFileSync(
    join(cwd, ".supatype", "dev-session.json"),
    JSON.stringify({ version: 1, composeProject: "supatype-acme", projectRef: "acme", composePath: "x", kongPort: 55560, startedAt: "t" }),
  )
}

const envValue = (key: string): string | undefined =>
  readFileSync(join(cwd, ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1)

describe("which mode a compose render uses (SH1, SH2)", () => {
  it("is dev while a supatype dev session holds the lock, whatever is running", () => {
    holdDevLock()
    docker.serverMode = "standalone"
    expect(composeRenderMode(cwd, "acme")).toBe("dev")
  })

  it("is the running server's mode when no dev session holds the lock", () => {
    docker.serverMode = "dev"
    expect(composeRenderMode(cwd, "acme")).toBe("dev")
    docker.serverMode = "standalone"
    expect(composeRenderMode(cwd, "acme")).toBe("standalone")
    expect(docker.calls[0]).toEqual(expect.arrayContaining(["label=com.docker.compose.project=supatype-acme"]))
  })

  it("is standalone when nothing is running and no dev session holds the lock", () => {
    expect(composeRenderMode(cwd, "acme")).toBe("standalone")
  })
})

describe("supatype push against the project's compose stack (SH1)", () => {
  it("keeps a standalone stack standalone and leaves the operator's .env alone", async () => {
    docker.serverMode = "standalone"

    await expect(pushSchemaDocker(cwd, config)).rejects.toThrow("rendered")

    expect(rendered.options[0]?.devLocal).toBe(false)
    expect(ensureDevDbPort).not.toHaveBeenCalled()
    expect(envValue("SITE_URL")).toBe("https://app.example.com")
    expect(envValue("API_EXTERNAL_URL")).toBe("https://api.example.com")
    expect(envValue("SUPATYPE_MAILER_AUTOCONFIRM")).toBe("false")
    expect(envValue("DATABASE_URL")).toBe("postgresql://supatype_admin:operator-password@localhost:5432/acme")
  })

  it("renders a stack nobody started as standalone", async () => {
    await expect(pushSchemaDocker(cwd, config)).rejects.toThrow("rendered")
    expect(rendered.options[0]?.devLocal).toBe(false)
  })

  it("waits on the port a standalone stack with TLS publishes its gateway on, 80", () => {
    const tls: SupatypeProjectConfig = {
      ...config,
      server: { mode: "standalone", domain: "app.example.com", tls: { email: "ops@example.com", provider: "kong" } },
    }
    expect(composeGatewayHostPort(tls, "standalone", 55560)).toBe(80)
    expect(composeGatewayHostPort(tls, "dev", 55560)).toBe(55560)
    expect(composeGatewayHostPort(config, "standalone", 55560)).toBe(55560)
  })

  it("keeps a supatype dev stack dev", async () => {
    holdDevLock()
    await expect(pushSchemaDocker(cwd, config)).rejects.toThrow("rendered")
    expect(rendered.options[0]?.devLocal).toBe(true)
  })
})
