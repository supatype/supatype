import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SpawnSyncReturns } from "node:child_process"

/**
 * `supatype dev --reset-db` is the only way `dev` removes local data, and it removes exactly one
 * volume: Postgres's. Storage and the cache volume are the developer's too, and nothing about a
 * database reset is a reason to lose uploaded files.
 *
 * It is opt-in and confirmed. Without a TTY there is nobody to confirm, so it is refused unless
 * `--yes` says the caller already decided.
 */

const spawnSync = vi.fn<(cmd: string, args: readonly string[]) => Partial<SpawnSyncReturns<string>>>()
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[]) => spawnSync(cmd, args),
}))

const runDockerCompose = vi.fn<(composePath: string, args: string[]) => number>(() => 0)
vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  runDockerCompose: (composePath: string, args: string[]) => runDockerCompose(composePath, args),
}))

const isInteractive = vi.fn(() => true)
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => isInteractive() }))

const confirm = vi.fn(async (_message: string) => false)
vi.mock("../src/ui/confirm.js", () => ({ confirm: (message: string) => confirm(message) }))

const lines: string[] = []
vi.mock("../src/ui/messages.js", () => ({
  error: (line: string) => lines.push(`error: ${line}`),
  plain: (line?: string) => lines.push(line ?? ""),
}))

const { devDbVolumeName, resetDevDatabase } = await import("../src/dev-db-reset.js")
const { DB_VOLUME_KEY, renderSelfHostCompose } = await import("../src/self-host-compose.js")
const { validateProjectConfig } = await import("../src/project-config.js")

const target = {
  composePath: "/proj/.supatype/self-host/docker-compose.yml",
  cwd: "/proj",
  project: "supatype-demo",
  external: false,
}

/** Every `docker volume rm` the code ran, by volume name. */
const removedVolumes = (): string[] =>
  spawnSync.mock.calls
    .filter(([, args]) => args[0] === "volume" && args[1] === "rm")
    .map(([, args]) => String(args[2]))

beforeEach(() => {
  lines.length = 0
  spawnSync.mockReset()
  spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" })
  runDockerCompose.mockClear()
  confirm.mockReset()
  confirm.mockResolvedValue(false)
  isInteractive.mockReturnValue(true)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("the volume --reset-db removes", () => {
  it("is the one the generated compose file mounts at Postgres's data directory", () => {
    const config = validateProjectConfig(
      { project: { name: "demo" }, server: { mode: "dev" }, app: { mode: "none" }, database: { provider: "docker" } },
      "supatype.config.ts",
    )
    const compose = renderSelfHostCompose(config)
    expect(compose).toContain(`- ${DB_VOLUME_KEY}:/var/lib/postgresql/data`)
    expect(compose).toMatch(new RegExp(`^volumes:[\\s\\S]*^ {2}${DB_VOLUME_KEY}:$`, "m"))
    expect(devDbVolumeName("supatype-demo")).toBe(`supatype-demo_${DB_VOLUME_KEY}`)
  })
})

describe("--reset-db without confirmation", () => {
  it("removes nothing when the prompt is declined", async () => {
    confirm.mockResolvedValue(false)

    await expect(resetDevDatabase(target, { yes: false })).rejects.toThrow("exit 1")

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]![0]).toContain("supatype-demo_db-data")
    expect(removedVolumes()).toEqual([])
    expect(runDockerCompose).not.toHaveBeenCalled()
  })

  it("is refused without a TTY unless --yes is passed, and removes nothing", async () => {
    isInteractive.mockReturnValue(false)

    await expect(resetDevDatabase(target, { yes: false })).rejects.toThrow("exit 1")

    expect(confirm).not.toHaveBeenCalled()
    expect(removedVolumes()).toEqual([])
    expect(runDockerCompose).not.toHaveBeenCalled()
    expect(lines.join("\n")).toContain("--yes")
  })

  it("is refused for a database Supatype does not run", async () => {
    await expect(
      resetDevDatabase({ ...target, external: true }, { yes: true }),
    ).rejects.toThrow("exit 1")

    expect(removedVolumes()).toEqual([])
    expect(runDockerCompose).not.toHaveBeenCalled()
  })
})

describe("--reset-db once confirmed", () => {
  it("removes only the Postgres data volume", async () => {
    confirm.mockResolvedValue(true)

    await resetDevDatabase(target, { yes: false })

    expect(removedVolumes()).toEqual(["supatype-demo_db-data"])
    // The db container has to go before its volume can, and nothing else may go with it.
    expect(runDockerCompose.mock.calls.map(([, args]) => args)).toEqual([["rm", "--stop", "--force", "db"]])
    for (const [, args] of runDockerCompose.mock.calls) {
      expect(args).not.toContain("-v")
      expect(args).not.toContain("down")
    }
  })

  it("skips the prompt with --yes, even without a TTY", async () => {
    isInteractive.mockReturnValue(false)

    await resetDevDatabase(target, { yes: true })

    expect(confirm).not.toHaveBeenCalled()
    expect(removedVolumes()).toEqual(["supatype-demo_db-data"])
  })

  it("does nothing when there is no volume yet", async () => {
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "Error: No such volume" })

    await resetDevDatabase(target, { yes: true })

    expect(removedVolumes()).toEqual([])
    expect(runDockerCompose).not.toHaveBeenCalled()
  })
})

describe("supatype dev", () => {
  it("offers --reset-db and --yes", async () => {
    const { registerDev } = await import("../src/commands/dev.js")
    const program = new Command()
    registerDev(program)
    const dev = program.commands.find((c) => c.name() === "dev")
    const flags = dev?.options.map((o) => o.long) ?? []
    expect(flags).toContain("--reset-db")
    expect(flags).toContain("--yes")
  })
})
