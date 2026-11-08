import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * Round 6: in a terminal, `up -d` let docker draw its progress into the screen the CLI was
 * redrawing, and every notice above it came out twice. There it runs docker quietly, keeping its
 * output for a failure, as `dev` does.
 */
const compose = vi.hoisted(() => ({ inherited: 0, quiet: 0 }))
vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: (cwd: string) => ({ composePath: join(cwd, "docker-compose.yml"), kongPath: "" }),
  runDockerCompose: () => {
    compose.inherited++
    return 0
  },
  runDockerComposeQuietly: async () => {
    compose.quiet++
    return 0
  },
}))
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderOptions: () => ({ devLocal: false }),
}))
vi.mock("../src/compose-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-services.js")>()),
  takenComposePorts: async () => [],
}))
const terminal = vi.hoisted(() => ({ interactive: true }))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => terminal.interactive }))
vi.mock("../src/ui/progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/progress.js")>()),
  withSpinner: <T>(_message: string, task: () => Promise<T>) => task(),
}))
vi.mock("../src/dev-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev-compose.js")>()),
  provisionStartedStack: async () => undefined,
}))

import { registerSelfHost } from "../src/commands/self-host.js"

let project: { dir: string; remove: () => void }

beforeEach(() => {
  compose.inherited = 0
  compose.quiet = 0
  project = tempProject("self-host-up-terminal")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "standalone" }, app: { mode: "none" } }\n`,
  )
  writeFileSync(join(project.dir, ".env"), "JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef\nANON_KEY=a\nSERVICE_ROLE_KEY=s\n")
})

afterEach(() => {
  project.remove()
})

describe("self-host compose up -d", () => {
  it("runs docker quietly in a terminal", async () => {
    terminal.interactive = true
    await runCommand(registerSelfHost, ["self-host", "compose", "up"], project.dir)
    expect(compose).toEqual({ inherited: 0, quiet: 1 })
  })

  it("lets docker print its own progress off a terminal", async () => {
    terminal.interactive = false
    await runCommand(registerSelfHost, ["self-host", "compose", "up"], project.dir)
    expect(compose).toEqual({ inherited: 1, quiet: 0 })
  })
})
