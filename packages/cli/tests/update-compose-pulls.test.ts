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
  // As compose behaves: a pull exits non-zero when any service it names fails, and with
  // --ignore-pull-failures, which update used to pass, it exits 0 whatever failed.
  runDockerCompose: vi.fn((_path: string, args: string[]) => {
    if (args[0] !== "pull" || args.includes("--ignore-pull-failures")) return 0
    return args.slice(1).some((arg) => stack.failing.has(arg)) ? 1 : 0
  }),
}))

vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderOptions: () => ({}),
}))

vi.mock("../src/dev-compose.js", () => ({ syncComposeImagePins: () => undefined }))

vi.mock("../src/compose-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-services.js")>()),
  composeServiceImages: () => stack.images,
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
})
