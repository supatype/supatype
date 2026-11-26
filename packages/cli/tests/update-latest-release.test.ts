import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import type { CliInstallMethod } from "../src/cli-install-method.js"

/**
 * `update` on a Docker project renders the compose file with the image pins this CLI carries, so a
 * CLI that is behind can never move them. It used to say nothing about that. It now looks up the
 * latest CLI release and, when one is newer, says to upgrade the CLI first, then carries on.
 */

const said = vi.hoisted(() => ({ lines: [] as string[] }))
const world = vi.hoisted(() => ({
  /** The version stamped into the running CLI; empty for a source build. */
  running: "0.9.0",
  /** What the release lookup answers, or the error it throws. */
  latest: "0.10.0" as string | Error,
  method: "npm" as CliInstallMethod,
}))

vi.mock("../src/cli-version-embedded.js", () => ({
  get EMBEDDED_CLI_VERSION(): string {
    return world.running
  },
}))

vi.mock("../src/cli-standalone.js", () => ({
  fetchStandaloneCliLatestVersion: vi.fn(async () => {
    if (world.latest instanceof Error) throw world.latest
    return world.latest
  }),
}))

vi.mock("../src/cli-install-method.js", () => ({ detectCliInstallMethod: () => world.method }))

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
  writeSelfHostCompose: vi.fn(() => ({ composePath: "/stack/docker-compose.yml" })),
  pullComposeImages: vi.fn(async () => 0),
  askDockerCompose: vi.fn(async () => ({ status: 0, stdout: "", stderr: "", timedOut: false, missing: false })),
}))

vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderOptions: () => ({}),
}))

vi.mock("../src/dev-compose.js", () => ({ syncComposeImagePins: () => undefined }))

vi.mock("../src/compose-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-services.js")>()),
  composeServiceImages: vi.fn(async () => []),
}))

vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  info: (message: string) => said.lines.push(message),
  warn: (message: string) => said.lines.push(message),
  error: (message: string) => said.lines.push(message),
  plain: (message = "") => said.lines.push(message),
}))

vi.mock("../src/ui/fatal.js", () => ({
  fatalError: (message: string): never => {
    throw new Error(message)
  },
}))

const { registerUpdate } = await import("../src/commands/update.js")
const { fetchStandaloneCliLatestVersion } = await import("../src/cli-standalone.js")
const { writeSelfHostCompose, pullComposeImages } = await import("../src/self-host-compose.js")

async function runUpdate(...flags: string[]): Promise<string> {
  const program = new Command().exitOverride()
  registerUpdate(program)
  await program.parseAsync(["node", "supatype", "update", ...flags])
  return said.lines.join("\n")
}

beforeEach(() => {
  said.lines.length = 0
  world.running = "0.9.0"
  world.latest = "0.10.0"
  world.method = "npm"
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("supatype update on a Docker project, when a newer CLI exists", () => {
  it("says a newer release exists and that the image pins come from the CLI version", async () => {
    const out = await runUpdate()
    expect(out).toMatch(/v0\.10\.0/)
    expect(out).toMatch(/v0\.9\.0/)
    expect(out).toMatch(/image pins come from the CLI version/i)
  })

  it("names the npm upgrade command for an npm install", async () => {
    expect(await runUpdate()).toContain("npm update -g @supatype/cli")
  })

  it("names the Homebrew upgrade command for a Homebrew install", async () => {
    world.method = "homebrew"
    expect(await runUpdate()).toContain("brew update && brew upgrade supatype")
  })

  it("names self-update and the install script for a standalone install", async () => {
    world.method = "standalone"
    const out = await runUpdate()
    expect(out).toContain("supatype self-update")
    expect(out).toContain("curl -fsSL https://supatype.com/install.sh | bash")
  })

  it("still pulls the images this CLI pins", async () => {
    const out = await runUpdate()
    expect(vi.mocked(writeSelfHostCompose)).toHaveBeenCalled()
    expect(vi.mocked(pullComposeImages)).toHaveBeenCalled()
    expect(out).toContain("Compose images updated.")
  })
})

describe("supatype update on a Docker project, when nothing newer exists", () => {
  it("says the pins are current for the running version", async () => {
    world.latest = "0.9.0"
    const out = await runUpdate()
    expect(out).toMatch(/pins are current for v0\.9\.0/)
    expect(out).not.toMatch(/newer release/i)
  })

  it("does not call a CLI ahead of the latest release out of date", async () => {
    world.running = "0.11.0"
    const out = await runUpdate()
    expect(out).not.toMatch(/newer release/i)
    expect(out).toMatch(/pins are current for v0\.11\.0/)
  })
})

describe("supatype update on a Docker project, when the lookup fails", () => {
  it("warns once and carries on to pull", async () => {
    world.latest = new Error("getaddrinfo ENOTFOUND releases.supatype.com")
    const out = await runUpdate()
    expect(out.match(/Could not check for a newer CLI release/g)).toHaveLength(1)
    expect(out).toContain("ENOTFOUND")
    expect(vi.mocked(pullComposeImages)).toHaveBeenCalled()
    expect(out).toContain("Compose images updated.")
  })
})

describe("supatype update on a CLI built from source", () => {
  it("skips the check, says why, and does not look anything up", async () => {
    world.running = ""
    const out = await runUpdate()
    expect(vi.mocked(fetchStandaloneCliLatestVersion)).not.toHaveBeenCalled()
    expect(out).toMatch(/built from source/i)
    expect(vi.mocked(pullComposeImages)).toHaveBeenCalled()
  })
})

describe("supatype update --check on a Docker project", () => {
  it("reports the running version, the latest, and that an upgrade would move the pins", async () => {
    const out = await runUpdate("--check")
    expect(out).toMatch(/Running CLI: v0\.9\.0/)
    expect(out).toMatch(/Latest CLI release: v0\.10\.0/)
    expect(out).toMatch(/would move the image pins/i)
    expect(out).toContain("npm update -g @supatype/cli")
  })

  it("pulls nothing and renders nothing", async () => {
    await runUpdate("--check")
    expect(vi.mocked(writeSelfHostCompose)).not.toHaveBeenCalled()
    expect(vi.mocked(pullComposeImages)).not.toHaveBeenCalled()
  })

  it("says the pins are current when already on the latest", async () => {
    world.latest = "0.9.0"
    const out = await runUpdate("--check")
    expect(out).toMatch(/Running CLI: v0\.9\.0/)
    expect(out).toMatch(/pins are current for v0\.9\.0/)
  })

  it("says it could not look the release up when the lookup fails", async () => {
    world.latest = new Error("offline")
    const out = await runUpdate("--check")
    expect(out).toMatch(/Could not check for a newer CLI release/)
    expect(out).toMatch(/Running CLI: v0\.9\.0/)
  })

  it("says a source build has no version to compare", async () => {
    world.running = ""
    const out = await runUpdate("--check")
    expect(vi.mocked(fetchStandaloneCliLatestVersion)).not.toHaveBeenCalled()
    expect(out).toMatch(/built from source/i)
  })
})
