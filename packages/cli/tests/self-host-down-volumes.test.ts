import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * Fresh-user test C9: `supatype self-host compose down` kept the volumes, said nothing about it,
 * and had no way to remove them, so starting over meant `docker volume rm` by hand. `--volumes`
 * removes them after a confirmation (or `--yes`), and a plain `down` says they were kept.
 */
const calls = vi.hoisted(() => ({ compose: [] as string[][], answer: false }))

vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: (cwd: string) => ({ composePath: join(cwd, "docker-compose.yml"), kongPath: "" }),
  runDockerCompose: (_path: string, args: string[]) => {
    calls.compose.push(args)
    return 0
  },
}))
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderOptions: () => ({ devLocal: false }),
}))
vi.mock("../src/ui/confirm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/confirm.js")>()),
  confirm: async () => calls.answer,
}))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => true }))

import { registerSelfHost } from "../src/commands/self-host.js"

let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("self-host-down")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "standalone" }, app: { mode: "none" } }\n`,
  )
  calls.compose = []
  calls.answer = false
})

afterEach(() => project.remove())

const down = (...extra: string[]) =>
  runCommand(registerSelfHost, ["self-host", "compose", "down", ...extra], project.dir)

describe("self-host compose down", () => {
  it("keeps the volumes by default and says so", async () => {
    const run = await down()
    expect(calls.compose).toEqual([["down"]])
    expect(run.output).toMatch(/volumes .*kept/i)
    expect(run.output).toContain("--volumes")
  })

  it("removes the volumes with --volumes --yes", async () => {
    await down("--volumes", "--yes")
    expect(calls.compose).toEqual([["down", "--volumes"]])
  })

  it("asks first with --volumes, and stops nothing when declined", async () => {
    const run = await down("--volumes")
    expect(calls.compose).toEqual([])
    expect(run.output).toMatch(/nothing/i)
  })

  it("removes them when the confirmation is accepted", async () => {
    calls.answer = true
    await down("--volumes")
    expect(calls.compose).toEqual([["down", "--volumes"]])
  })
})
