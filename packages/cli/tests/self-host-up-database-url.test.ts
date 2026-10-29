import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { MANAGED_MARKER } from "../src/env-file.js"

/**
 * B5 follow-up: a self-host push points DATABASE_URL at the self-host port, but a stack started
 * with `self-host compose up` and never pushed kept whatever URL `.env` had, which in a project
 * that had run dev was the dev database's. Seed and admin then reached the dev database. `up` now
 * syncs DATABASE_URL to the layout it renders, the same way push does.
 */
const compose = vi.hoisted(() => ({ calls: [] as string[][], devLocal: false }))

vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: (cwd: string) => ({ composePath: join(cwd, "docker-compose.yml"), kongPath: "" }),
  runDockerCompose: (_path: string, args: string[]) => {
    compose.calls.push(args)
    return 0
  },
}))
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderOptions: () => ({ devLocal: compose.devLocal }),
}))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => false }))

import { registerSelfHost } from "../src/commands/self-host.js"

let project: { dir: string; remove: () => void }

// Marked as the CLI's: a hand-written URL is never moved (database-url-owner-selfhost.test.ts).
const env = (url: string) =>
  [
    MANAGED_MARKER,
    `DATABASE_URL=${url}`,
    "SUPATYPE_DEV_DB_PORT=54329",
    "SUPATYPE_DB_PORT=54390",
    "JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef",
    "ANON_KEY=a",
    "SERVICE_ROLE_KEY=s",
    "",
  ].join("\n")

beforeEach(() => {
  project = tempProject("self-host-up")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "standalone" }, app: { mode: "none" } }\n`,
  )
  compose.calls = []
  compose.devLocal = false
  for (const key of ["DATABASE_URL", "SUPATYPE_DEV_DB_PORT", "SUPATYPE_DB_PORT"]) vi.stubEnv(key, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  project.remove()
})

const databaseUrl = () => /^DATABASE_URL=(.*)$/m.exec(readFileSync(join(project.dir, ".env"), "utf8"))?.[1]

describe("self-host compose up", () => {
  it("points a dev-port DATABASE_URL at the self-host port and names SUPATYPE_DB_PORT", async () => {
    writeFileSync(join(project.dir, ".env"), env("postgresql://u:p@127.0.0.1:54329/acme"))
    const run = await runCommand(registerSelfHost, ["self-host", "compose", "up"], project.dir)
    expect(compose.calls).toEqual([["up", "-d"]])
    expect(databaseUrl()).toBe("postgresql://u:p@127.0.0.1:54390/acme")
    expect(run.output).toContain("to match SUPATYPE_DB_PORT")
  })

  it("leaves a URL already on the self-host port alone", async () => {
    writeFileSync(join(project.dir, ".env"), env("postgresql://u:p@127.0.0.1:54390/acme"))
    const run = await runCommand(registerSelfHost, ["self-host", "compose", "up"], project.dir)
    expect(databaseUrl()).toBe("postgresql://u:p@127.0.0.1:54390/acme")
    expect(run.output).not.toContain("DATABASE_URL port")
  })
})
