import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * EXT-N1 and CE1. After a push recreated the server, Kong kept sending to the old container's
 * address and sign-in answered 502 until Kong was restarted. Shortening Kong's DNS TTLs was tried
 * and broke Studio from its dev server: Kong dropped the hosts-file entry for host.docker.internal
 * after 5 s. So the compose file leaves Kong's DNS alone, and the CLI reloads Kong whenever it
 * recreates a container behind it.
 */
const spawnSync = vi.hoisted(() => vi.fn<(cmd: string, args: string[]) => { status: number | undefined; stdout: string; stderr?: string }>())
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}))
// No daemon is asked about: every docker call here is the mocked spawnSync.
vi.mock("../src/docker-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-runtime.js")>()),
  requireDockerDaemon: () => undefined,
}))

const config = validateProjectConfig(
  {
    project: { name: "acme" },
    server: { mode: "dev" },
    app: { mode: "none" },
    database: { provider: "docker" },
    versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
  },
  "supatype.config.ts",
)

function kongBlock(compose: string): string {
  const start = compose.indexOf("\n  kong:\n")
  expect(start).toBeGreaterThan(-1)
  const rest = compose.slice(start + 1)
  const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return end === -1 ? rest : rest.slice(0, end + 1)
}

describe("Kong's DNS cache", () => {
  for (const devLocal of [true, false]) {
    it(`is left at Kong's defaults, so hosts-file entries keep resolving (${devLocal ? "dev" : "self-host"})`, () => {
      const kong = kongBlock(renderSelfHostCompose(config, process.cwd(), { devLocal }))
      expect(kong).not.toMatch(/KONG_DNS_/)
      expect(kong).toContain('"host.docker.internal:host-gateway"')
    })
  }
})

describe("Kong after an up the CLI runs", () => {
  const cwd = process.cwd()
  const stack = { composePath: "compose.yml", project: "supatype-acme" }
  /** The two calls that list the running containers: compose for the ids, docker for the rest. */
  const listing = [["ps", "-q", "--filter", "label=com.docker.compose.project=supatype-acme"], ["inspect"]]
  const health = ["exec", "-T", "kong", "kong", "health"]
  const reload = ["exec", "-T", "kong", "kong", "reload"]
  /** Each docker call made, from its subcommand on; an inspect is its subcommand alone. */
  const ran = (): string[][] =>
    spawnSync.mock.calls.map((call) => {
      const args = call[1]
      const at = args.findIndex((a) => ["ps", "up", "exec", "restart", "inspect"].includes(a))
      return args[at] === "inspect" ? ["inspect"] : args.slice(at)
    })

  /** A service's container: its id, on an address of its own unless one is given. */
  type Container = string | { id: string; address: string }
  const idOf = (c: Container) => (typeof c === "string" ? c : c.id)
  const addressOf = (c: Container) => (typeof c === "string" ? `10.0.0.${c}` : c.address)

  /**
   * Docker answering as a stack whose running containers are `before` until an `up` runs and
   * `after` once it has. `health` and `reload` are what `kong health` and `kong reload` exit with,
   * call by call, the last one repeating.
   */
  function stackAnswers(
    before: Record<string, Container>,
    after: Record<string, Container>,
    kong: { health?: number[]; reload?: number[] } = {},
  ): void {
    let upRan = false
    const healthAnswers = [...(kong.health ?? [0])]
    const reloadAnswers = [...(kong.reload ?? [0])]
    const next = (answers: number[]) => (answers.length > 1 ? answers.shift() : answers[0])
    const current = () => Object.entries(upRan ? after : before)
    const inspected = (ids: string[]) =>
      current()
        .filter(([, c]) => ids.includes(idOf(c)))
        .map(([service, c]) => `${service} ${idOf(c)} ${addressOf(c)}\n`)
        .join("")
    spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("up")) upRan = true
      if (args[0] === "inspect") return { status: 0, stdout: inspected(args.slice(3)) }
      if (args.includes("ps")) return { status: 0, stdout: current().map(([, c]) => `${idOf(c)}\n`).join("") }
      if (args.includes("health")) return { status: next(healthAnswers), stdout: "", stderr: "" }
      if (args.includes("reload")) return { status: next(reloadAnswers), stdout: "", stderr: "" }
      return { status: 0, stdout: "", stderr: "" }
    })
  }

  beforeEach(() => {
    spawnSync.mockReset()
  })

  it("reloads a Kong that was running when the up moved a container behind it to a new address", async () => {
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    stackAnswers({ kong: "1", server: "2", postgrest: "3" }, { kong: "1", server: "4", postgrest: "3" })
    const up = ["up", "-d", "--force-recreate", "--no-deps", "server"]
    expect(runDockerCompose(stack.composePath, up, cwd, stack.project)).toBe(0)
    expect(ran()).toEqual([...listing, up, ...listing, reload])
  })

  it("leaves Kong alone when the recreated container came back on the address Kong holds", async () => {
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    const kong = { id: "k1", address: "10.0.0.1" }
    stackAnswers(
      { kong, server: { id: "s1", address: "10.0.0.2" } },
      { kong, server: { id: "s2", address: "10.0.0.2" } },
    )
    expect(runDockerCompose(stack.composePath, ["up", "-d"], cwd, stack.project)).toBe(0)
    expect(ran()).toEqual([...listing, ["up", "-d"], ...listing])
  })

  it("reloads after an up that started a stopped upstream", async () => {
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    stackAnswers({ kong: "1" }, { kong: "1", postgrest: "2" })
    expect(runDockerCompose(stack.composePath, ["up", "-d"], cwd, stack.project)).toBe(0)
    expect(ran().at(-1)).toEqual(reload)
  })

  it("leaves Kong alone when the up started it: a dev start", async () => {
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    stackAnswers({ db: "1" }, { db: "1", server: "2", postgrest: "3", kong: "4" })
    expect(runDockerCompose(stack.composePath, ["up", "-d"], cwd, stack.project)).toBe(0)
    // No Kong before the up: nothing is listed after it.
    expect(ran()).toEqual([...listing, ["up", "-d"]])
  })

  it("leaves Kong alone when the up recreated Kong itself", async () => {
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    stackAnswers({ kong: "1", server: "2" }, { kong: "3", server: "4" })
    expect(runDockerCompose(stack.composePath, ["up", "-d"], cwd, stack.project)).toBe(0)
    expect(ran()).toEqual([...listing, ["up", "-d"], ...listing])
  })

  it("leaves Kong alone when the up recreated nothing", async () => {
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    const same = { kong: "1", server: "2", postgrest: "3" }
    stackAnswers(same, same)
    expect(runDockerCompose(stack.composePath, ["up", "-d"], cwd, stack.project)).toBe(0)
    expect(ran()).toEqual([...listing, ["up", "-d"], ...listing])
  })

  it("waits for a Kong still starting when its reload fails, then reloads it and never restarts it", async () => {
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    stackAnswers({ kong: "1", server: "2" }, { kong: "1", server: "3" }, { health: [1, 1, 0], reload: [1, 0] })
    expect(runDockerCompose(stack.composePath, ["up", "-d"], cwd, stack.project)).toBe(0)
    expect(ran().slice(5)).toEqual([reload, health, health, health, reload])
  })

  it("warns, and never restarts Kong, when it does not become ready or the reload fails", async () => {
    const { reloadKong } = await import("../src/compose-kong.js")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    stackAnswers({}, {}, { health: [1], reload: [1] })
    expect(reloadKong(cwd, stack, 0)).toBe(false)
    stackAnswers({}, {}, { reload: [1] })
    expect(reloadKong(cwd, stack, 0)).toBe(false)
    expect(ran().filter((args) => args[0] === "restart")).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it("reloads only for a service Kong sends to, as its kong.yml names them", async () => {
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    const project = mkdtempSync(join(tmpdir(), "kong-upstreams-"))
    try {
      writeFileSync(
        join(project, "kong.yml"),
        [
          "services:",
          "  - name: auth",
          "    url: http://server:9999",
          "  - name: graphql",
          "    url: http://postgrest:3000/rpc/graphql",
          "  - name: studio",
          "    url: http://host.docker.internal:13140",
        ].join("\n"),
      )
      const running = { kong: "1", server: "2", postgrest: "3", storage: "4", realtime: "5" }
      // Storage and realtime are reached through the server, never by Kong.
      stackAnswers(running, { ...running, storage: "6", realtime: "7" })
      expect(runDockerCompose(stack.composePath, ["up", "-d"], project, stack.project)).toBe(0)
      expect(ran()).toEqual([...listing, ["up", "-d"], ...listing])
      spawnSync.mockReset()
      // GraphQL goes to PostgREST directly, so a moved PostgREST is one Kong must look up again.
      stackAnswers(running, { ...running, postgrest: "8" })
      expect(runDockerCompose(stack.composePath, ["up", "-d"], project, stack.project)).toBe(0)
      expect(ran().at(-1)).toEqual(reload)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it("reloads a running Kong when the containers could not be listed on one side of the up", async () => {
    const { kongNeedsReload } = await import("../src/compose-kong.js")
    const kong = new Map([["kong", { id: "k1", addresses: "10.0.0.1" }]])
    expect(kongNeedsReload(kong, undefined)).toBe(true)
    expect(kongNeedsReload(undefined, kong)).toBe(true)
    expect(kongNeedsReload(new Map(), undefined)).toBe(false)
  })

  it("reloads nothing after a failed up or another command", async () => {
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    stackAnswers({ kong: "1", server: "2" }, { kong: "1", server: "3" })
    const listed = spawnSync.getMockImplementation()!
    spawnSync.mockImplementation((cmd: string, args: string[]) =>
      args.includes("up") ? { status: 1, stdout: "", stderr: "" } : listed(cmd, args),
    )
    expect(runDockerCompose(stack.composePath, ["up", "-d"], cwd, stack.project, { quiet: true })).toBe(1)
    expect(ran()).toEqual([...listing, ["up", "-d"]])
    spawnSync.mockReset()
    spawnSync.mockImplementation(() => ({ status: 0, stdout: "" }))
    runDockerCompose(stack.composePath, ["restart", "functions-worker"], cwd, stack.project)
    expect(ran()).toEqual([["restart", "functions-worker"]])
  })
})
