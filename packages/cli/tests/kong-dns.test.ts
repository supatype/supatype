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
const spawnSync = vi.hoisted(() => vi.fn())
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

describe("recreating a container behind Kong", () => {
  const cwd = process.cwd()
  const stack = { composePath: "compose.yml", project: "supatype-acme" }
  /** Each docker compose subcommand run, from `ps`, `up`, `exec` or `restart` on. */
  const ran = (): string[][] =>
    spawnSync.mock.calls.map((call) => {
      const args = call[1] as string[]
      const at = args.findIndex((a) => ["ps", "up", "exec", "restart"].includes(a))
      return args.slice(at)
    })

  beforeEach(() => {
    spawnSync.mockReset()
    spawnSync.mockImplementation((_cmd: string, args: string[]) =>
      args.includes("ps") ? { status: 0, stdout: "kong-container-id\n" } : { status: 0, stdout: "" },
    )
  })

  it("reloads a running Kong after every up the CLI runs", async () => {
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    expect(runDockerCompose(stack.composePath, ["up", "-d", "--force-recreate", "--no-deps", "server"], cwd, stack.project)).toBe(0)
    expect(ran()).toEqual([
      ["up", "-d", "--force-recreate", "--no-deps", "server"],
      ["ps", "-q", "--status", "running", "kong"],
      ["exec", "-T", "kong", "kong", "reload"],
    ])
  })

  it("restarts Kong when the reload could not run", async () => {
    const { reloadKong } = await import("../src/compose-kong.js")
    spawnSync.mockImplementation((_cmd: string, args: string[]) =>
      args.includes("ps") ? { status: 0, stdout: "id\n" } : { status: args.includes("exec") ? 1 : 0, stdout: "" },
    )
    expect(reloadKong(cwd, stack)).toBe(true)
    expect(ran().at(-1)).toEqual(["restart", "kong"])
  })

  it("leaves a Kong that is not running alone, and reloads nothing after a failed up or another command", async () => {
    const { reloadKong } = await import("../src/compose-kong.js")
    const { runDockerCompose } = await import("../src/self-host-compose.js")
    spawnSync.mockImplementation(() => ({ status: 0, stdout: "" }))
    expect(reloadKong(cwd, stack)).toBe(true)
    expect(ran()).toEqual([["ps", "-q", "--status", "running", "kong"]])
    spawnSync.mockReset()
    spawnSync.mockImplementation(() => ({ status: 1, stdout: "" }))
    expect(runDockerCompose(stack.composePath, ["up", "-d"], cwd, stack.project, { quiet: true })).toBe(1)
    expect(ran()).toEqual([["up", "-d"]])
    spawnSync.mockReset()
    spawnSync.mockImplementation(() => ({ status: 0, stdout: "" }))
    runDockerCompose(stack.composePath, ["restart", "functions-worker"], cwd, stack.project)
    expect(ran()).toEqual([["restart", "functions-worker"]])
  })
})
