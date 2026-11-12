import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * 0.9.2 round 2 (R2-S10): after a failed `compose up` under dev's dashboard, the screen left after
 * the dashboard exited said only "docker compose failed (exit 1)". The reason compose gave was in
 * the frozen pane, cut at the window's width. The fatal message now carries it.
 */
const POOLS = "failed to create network supatype-acme_functions: Error response from daemon: all predefined address pools have been fully subnetted"
const docker = vi.hoisted(() => ({ upStatus: 1, upStderr: "" }))
vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDocker: async () => ({ status: docker.upStatus, stdout: "", stderr: docker.upStderr, timedOut: false, missing: false }),
  askDockerSync: (args: readonly string[]) =>
    args[0] === "network" ? { status: 0, stdout: "n1\nn2\n", stderr: "" } : { status: 0, stdout: "", stderr: "" },
}))
vi.mock("../src/docker-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-runtime.js")>()),
  requireDockerDaemonAsync: async () => undefined,
}))
vi.mock("../src/compose-kong.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-kong.js")>()),
  upKeepingKongCurrentAsync: async <T>(_cwd: string, _stack: unknown, up: () => Promise<T>) => up(),
}))
const said = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  error: (message: string) => said.lines.push(message),
  plain: (message = "") => said.lines.push(message),
}))

import { exitComposeFailed, runDockerComposeQuietly } from "../src/self-host-compose.js"

class Exited extends Error {}

/** exitComposeFailed's message and hints, as fatalError prints them, with process.exit stopped. */
function fatalLines(): string[] {
  said.lines = []
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Exited()
  })
  expect(() => exitComposeFailed(1, "Could not start the local Compose stack.")).toThrow(Exited)
  return said.lines
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a failed compose run's fatal message", () => {
  it("carries the reason compose gave, and the cause recognised, in full", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    docker.upStatus = 1
    docker.upStderr = POOLS
    expect(await runDockerComposeQuietly("compose.yml", ["up", "-d"], process.cwd(), "supatype-acme")).toBe(1)
    const text = fatalLines().join("\n")
    expect(text).toContain(`docker compose: ${POOLS}`)
    expect(text).toContain("Docker has no network addresses left for a new compose project")
    expect(text).toContain("There are 2 Supatype networks on this machine.")
    expect(text).toContain("Could not start the local Compose stack.")
  })

  it("does not carry a reason from an earlier run that went through", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    docker.upStatus = 1
    docker.upStderr = POOLS
    await runDockerComposeQuietly("compose.yml", ["up", "-d"], process.cwd(), "supatype-acme")
    docker.upStatus = 0
    docker.upStderr = ""
    expect(await runDockerComposeQuietly("compose.yml", ["up", "-d"], process.cwd(), "supatype-acme")).toBe(0)
    expect(fatalLines().join("\n")).not.toContain(POOLS)
  })
})
