import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * Local test N6: `update` on a Docker project pulled with `--ignore-pull-failures` whenever the
 * project might use an image built on this machine. Compose then exits 0 whatever failed, so five
 * pulls ending "not found" were followed by "Compose images updated." and exit 0. Bug I had been
 * fixed for binary downloads only. A pull that fails is a component that could not be updated.
 */

const messages = vi.hoisted(() => ({ info: [] as string[], error: [] as string[] }))
const stack = vi.hoisted(() => ({
  images: [] as Array<{ service: string; image: string }>,
  /** Services whose pull fails on its own. */
  failing: new Set<string>(),
  /** Images Docker has on this machine. */
  local: new Set<string>(),
  /** Each single-service pull's start and end, in the order they happened. */
  events: [] as string[],
}))

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: (): SupatypeProjectConfig => ({
    project: { name: "demo" },
    provider: "docker",
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
  }),
}))

vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: () => ({ composePath: "/stack/docker-compose.yml" }),
  // As compose behaves: a pull exits non-zero when any service it names fails (every service when
  // it names none), and with --ignore-pull-failures, which update used to pass, it exits 0.
  runDockerCompose: vi.fn((_path: string, args: string[]) => {
    if (args[0] !== "pull" || args.includes("--ignore-pull-failures")) return 0
    const named = args.slice(1)
    const pulled = named.length > 0 ? named : stack.images.map((one) => one.service)
    return pulled.some((service) => stack.failing.has(service)) ? 1 : 0
  }),
  askDockerCompose: vi.fn(async (_path: string, args: string[]) => {
    const service = args[1] ?? ""
    stack.events.push(`start ${service}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    stack.events.push(`end ${service}`)
    const failed = stack.failing.has(service)
    return { status: failed ? 1 : 0, stdout: "", stderr: failed ? `${service} Pulling\nmanifest unknown` : "", timedOut: false, missing: false }
  }),
}))

vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderOptions: () => ({}),
}))

vi.mock("../src/dev-compose.js", () => ({ syncComposeImagePins: () => undefined }))

vi.mock("../src/compose-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-services.js")>()),
  composeServiceImages: vi.fn(async () => stack.images),
}))

vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  dockerHasImage: (image: string) => stack.local.has(image),
}))

vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  info: (message: string) => messages.info.push(message),
  error: (message: string) => messages.error.push(message),
  plain: () => undefined,
}))

vi.mock("../src/ui/fatal.js", () => ({
  fatalError: (message: string, hints: string[] = []): never => {
    throw new Error([message, ...hints].join("\n"))
  },
}))

const { registerUpdate } = await import("../src/commands/update.js")
const { composeServiceImages } = await import("../src/compose-services.js")

async function runUpdate(): Promise<void> {
  const program = new Command().exitOverride()
  registerUpdate(program)
  await program.parseAsync(["node", "supatype", "update"])
}

beforeEach(() => {
  messages.info.length = 0
  messages.error.length = 0
  stack.images = [
    { service: "db", image: "supatype/postgres:17.2.10" },
    { service: "storage", image: "supatype/storage:0.7.0" },
    { service: "server", image: "supatype/server:local-dev" },
  ]
  stack.failing = new Set()
  stack.local = new Set()
  stack.events = []
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("supatype update on a Docker project", () => {
  it("exits non-zero naming the image that could not be pulled, and never says updated", async () => {
    stack.failing.add("storage")
    await expect(runUpdate()).rejects.toThrow(/could not be updated[\s\S]*storage \(supatype\/storage:0\.7\.0\)/)
    expect(messages.info).not.toContain("Compose images updated.")
  })

  it("keeps an image built on this machine that no registry has, and says so", async () => {
    stack.failing.add("server")
    stack.local.add("supatype/server:local-dev")
    await expect(runUpdate()).resolves.toBeUndefined()
    expect(messages.info.join("\n")).toMatch(/server: supatype\/server:local-dev is not on its registry; kept the image on this machine/)
    expect(messages.info).toContain("Compose images updated.")
  })

  it("fails a local-only tag that this machine does not have either", async () => {
    stack.failing.add("server")
    await expect(runUpdate()).rejects.toThrow(/server \(supatype\/server:local-dev\)/)
  })

  it("says the images were updated when every pull worked", async () => {
    await expect(runUpdate()).resolves.toBeUndefined()
    expect(messages.info).toContain("Compose images updated.")
  })

  // `docker compose config` is a second pass over the whole file, and a pull that worked has no use for it.
  it("does not ask compose for its services when the pull works", async () => {
    await runUpdate()
    expect(vi.mocked(composeServiceImages)).not.toHaveBeenCalled()
  })

  // Each pull waits on a registry; one after another, a slow registry cost the sum of them.
  it("pulls the services again side by side when the pull fails, naming what Docker said", async () => {
    stack.failing.add("storage")
    await expect(runUpdate()).rejects.toThrow(/storage \(supatype\/storage:0\.7\.0\): docker compose could not pull it: manifest unknown/)
    const starts = stack.events.filter((event) => event.startsWith("start ")).length
    expect(starts).toBe(stack.images.length)
    expect(stack.events.slice(0, starts).every((event) => event.startsWith("start "))).toBe(true)
  })
})
