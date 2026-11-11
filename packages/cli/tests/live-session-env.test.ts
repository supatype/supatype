import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readEnvFile } from "../src/env-file.js"
import { interpolated } from "./support/live-session.js"
import { projectConfig as configWith } from "./support/project-config.js"

/**
 * 0.9.2 release test FF-7: `supatype dev` given SUPATYPE_KONG_PORT=18780 and SUPATYPE_DEV_DB_PORT=54780
 * by its shell keeps them, and the URLs built from them, out of `.env` (DR9). A command from a shell
 * without them rendered and ran compose with `.env`'s values, and recreated the running stack on them.
 * The session's lock records what dev holds for its run, and a command that settles on the local
 * stack enters it (`enterLocalStack`), taking those values before it reads a port.
 */

const projectConfig = configWith({ project: { name: "acme" }, database: { provider: "docker" } })

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>()
  return { ...actual, loadConfig: () => projectConfig }
})

/** The values compose interpolates at one compose command: this process's environment, then `.env`. */
interface ComposeRun {
  args: string[]
  project: string | undefined
  kongPort: string | undefined
  dbPort: string | undefined
  apiUrl: string | undefined
  siteUrl: string | undefined
}

const runs: ComposeRun[] = []

vi.mock("../src/self-host-compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/self-host-compose.js")>()
  return {
    ...actual,
    writeSelfHostCompose: (cwd: string) => ({
      dir: cwd,
      composePath: join(cwd, "docker-compose.yml"),
      kongPath: join(cwd, "kong.yml"),
      nginxPath: join(cwd, "nginx.conf"),
      s3ConfigPath: join(cwd, "s3.json"),
    }),
    runDockerCompose: (_composePath: string, args: string[], _root?: string, project?: string) => {
      runs.push({
        args,
        project,
        kongPort: interpolated("SUPATYPE_KONG_PORT", process.cwd()),
        dbPort: interpolated("SUPATYPE_DEV_DB_PORT", process.cwd()),
        apiUrl: interpolated("API_EXTERNAL_URL", process.cwd()),
        siteUrl: interpolated("SITE_URL", process.cwd()),
      })
      return 0
    },
  }
})

vi.mock("../src/stack-exit-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stack-exit-watch.js")>()),
  composeStackWatch: () => ({ logTail: async () => "" }),
  watchForFailure: async () => undefined,
}))

const { registerSelfHost } = await import("../src/commands/self-host.js")
const { rootProgram } = await import("../src/cli.js")
const { composeKongHostPort, localPublicApiUrl } = await import("../src/local-gateway.js")
const { composeDbHostPort } = await import("../src/host-database.js")
const { hostDatabaseUrl } = await import("../src/resolve-target.js")
const { devSessionLockFor, devSessionLockPath, enterLocalStack, liveDevSessionLock, writeDevSessionLock } = await import("../src/dev-session-lock.js")
const { selfHostComposePaths } = await import("../src/self-host-compose.js")
const { FRONTEND_URL_KEYS } = await import("../src/frontend-env.js")

const SESSION = "http://localhost:18780"
const STALE = "http://localhost:18473"
const SESSION_RUN_ENV: Record<string, string> = {
  SUPATYPE_KONG_PORT: "18780",
  SUPATYPE_DEV_DB_PORT: "54780",
  API_EXTERNAL_URL: SESSION,
  SITE_URL: SESSION,
  VITE_SUPATYPE_URL: SESSION,
}
const DOT_ENV_LINES = ["SUPATYPE_KONG_PORT=18473", "SUPATYPE_DEV_DB_PORT=54329", `API_EXTERNAL_URL=${STALE}`, `SITE_URL=${STALE}`, "POSTGRES_PASSWORD=pw", "POSTGRES_DB=acme", "POSTGRES_USER=acme"]
const RUN_KEYS = ["SUPATYPE_PROJECT_NAME", "SUPATYPE_KONG_PORT", "SUPATYPE_DEV_DB_PORT", "API_EXTERNAL_URL", "SITE_URL", "DATABASE_URL", ...FRONTEND_URL_KEYS]

let projectDir = ""
let originalCwd = ""

/** The live session `supatype dev` holds in this folder; `runEnv` absent is a lock an older dev wrote. */
function devSession(runEnv?: Record<string, string>): void {
  const stack = { composeProject: "supatype-acme", composePath: selfHostComposePaths(projectDir).composePath, kongPort: 18780, dbPort: 54780 }
  writeDevSessionLock(projectDir, devSessionLockFor(projectConfig, { ...stack, ...(runEnv !== undefined && { runEnv }) }))
}

/** The CLI's own root program, with the self-host commands on it. */
function program(): Command {
  const root = rootProgram().exitOverride()
  registerSelfHost(root)
  return root
}

async function supatype(...args: string[]): Promise<void> {
  await program().parseAsync(["node", "supatype", ...args])
}

beforeEach(() => {
  projectDir = join(tmpdir(), `supatype-live-session-env-${process.pid}-${Date.now()}`)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, ".env"), DOT_ENV_LINES.map((line) => `${line}\n`).join(""))
  originalCwd = process.cwd()
  process.chdir(projectDir)
  runs.length = 0
  for (const key of RUN_KEYS) vi.stubEnv(key, "")
  process.exitCode = undefined
})

afterEach(() => {
  process.chdir(originalCwd)
  process.exitCode = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(projectDir, { recursive: true, force: true })
})

describe("self-host compose restart while this folder's dev session runs", () => {
  it("recreates the service with the session's ports and URLs, not .env's", async () => {
    devSession(SESSION_RUN_ENV)
    await supatype("self-host", "compose", "restart", "server")

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ project: "supatype-acme", kongPort: "18780", dbPort: "54780", apiUrl: SESSION, siteUrl: SESSION })
    // The session's values were its shell's, and stay out of .env as dev kept them out (DR9).
    expect(readEnvFile(projectDir)["API_EXTERNAL_URL"]).toBe(STALE)
    expect(readFileSync(join(projectDir, ".env"), "utf8")).not.toMatch(/18780|54780/)
  })

  it("takes the two ports alone from a lock an older dev wrote", async () => {
    devSession()
    await supatype("self-host", "compose", "restart", "server")

    expect(runs[0]).toMatchObject({ kongPort: "18780", dbPort: "54780", apiUrl: STALE })
  })

  it("keeps what the command's own shell sets", async () => {
    devSession(SESSION_RUN_ENV)
    vi.stubEnv("API_EXTERNAL_URL", "http://localhost:18999")
    await supatype("self-host", "compose", "restart", "server")

    expect(runs[0]).toMatchObject({ kongPort: "18780", apiUrl: "http://localhost:18999", siteUrl: SESSION })
  })

  it("takes nothing when --project-name names another stack", async () => {
    devSession(SESSION_RUN_ENV)
    await supatype("--project-name", "other", "self-host", "compose", "restart", "server")

    expect(runs[0]).toMatchObject({ kongPort: "18473", dbPort: "54329", apiUrl: STALE, siteUrl: STALE })
  })

  it("takes the session's when --project-name names the session's own stack", async () => {
    devSession(SESSION_RUN_ENV)
    await supatype("--project-name", "acme", "self-host", "compose", "restart", "server")

    expect(runs[0]).toMatchObject({ kongPort: "18780", apiUrl: SESSION })
  })

  it("takes nothing with no live session", async () => {
    await supatype("self-host", "compose", "restart", "server")

    expect(runs[0]).toMatchObject({ kongPort: "18473", apiUrl: STALE })
  })
})

/**
 * The gateway and database the host-side commands reach are the environment's, which entering the
 * local stack fills. Read from the session's lock instead, they were dev's even for a run under
 * another stack's name, whose own stack was then built on other ports (FF-7 follow-up).
 */
describe("the local stack's gateway and database from the host while dev runs here", () => {
  it("are the session's once the stack is entered", () => {
    devSession(SESSION_RUN_ENV)
    enterLocalStack(projectDir, "acme")

    expect(composeKongHostPort(projectDir)).toBe(18780)
    expect(composeDbHostPort(projectDir, "dev")).toBe(54780)
    expect(localPublicApiUrl(projectDir)).toBe(SESSION)
  })

  it("are the session's for a host command's own database (push --direct, seed, migrate)", () => {
    devSession({ ...SESSION_RUN_ENV, DATABASE_URL: "postgresql://acme:pw@127.0.0.1:54780/acme" })

    expect(hostDatabaseUrl(projectDir, projectConfig)).toContain(":54780/")
    expect(composeKongHostPort(projectDir)).toBe(18780)
  })

  it("are the other stack's for a run under another name (push --direct --project-name other)", () => {
    devSession(SESSION_RUN_ENV)
    vi.stubEnv("SUPATYPE_PROJECT_NAME", "other")
    const databaseUrl = hostDatabaseUrl(projectDir, { ...projectConfig, project: { name: "other" } })

    expect(databaseUrl).toContain(":54329/")
    expect(composeKongHostPort(projectDir)).toBe(18473)
    expect(localPublicApiUrl(projectDir)).toBe(STALE)
    expect(process.env["DATABASE_URL"]).toBe("")
  })
})

describe("the session lock's run environment", () => {
  it("reads back as dev wrote it", () => {
    devSession(SESSION_RUN_ENV)
    expect(liveDevSessionLock(projectDir)?.runEnv).toEqual(SESSION_RUN_ENV)
  })

  it("makes the lock unreadable when it is not a map of strings", () => {
    devSession(SESSION_RUN_ENV)
    const composePath = selfHostComposePaths(projectDir).composePath
    const lock = { version: 1, composeProject: "supatype-acme", projectRef: "acme", composePath, kongPort: 18780, startedAt: "x", pid: process.pid }
    writeFileSync(devSessionLockPath(projectDir), JSON.stringify({ ...lock, runEnv: { SUPATYPE_KONG_PORT: 18780 } }))
    expect(liveDevSessionLock(projectDir)).toBeNull()
  })
})
