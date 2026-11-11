import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * Fresh-user test C9: `supatype self-host compose down` kept the volumes, said nothing about it,
 * and had no way to remove them, so starting over meant `docker volume rm` by hand. `--volumes`
 * removes them after a confirmation (or `--yes`), and a plain `down` says they were kept.
 */
const calls = vi.hoisted(() => ({ compose: [] as string[][], answer: false, left: [] as string[] }))

vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: (cwd: string) => ({ composePath: join(cwd, "docker-compose.yml"), kongPath: "" }),
  runDockerCompose: (_path: string, args: string[]) => {
    calls.compose.push(args)
    return 0
  },
  composeProjectVolumes: () => calls.left,
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
  calls.left = []
})

afterEach(() => project.remove())

const down = (...extra: string[]) =>
  runCommand(registerSelfHost, ["self-host", "compose", "down", ...extra], project.dir)

describe("self-host compose down", () => {
  it("keeps the volumes by default and says so", async () => {
    const run = await down()
    expect(calls.compose).toEqual([["down", "--remove-orphans"]])
    expect(run.output).toMatch(/volumes .*kept/i)
    expect(run.output).toContain("--volumes")
  })

  it("removes the volumes with --volumes --yes", async () => {
    await down("--volumes", "--yes")
    expect(calls.compose).toEqual([["down", "--volumes", "--remove-orphans"]])
  })

  it("asks first with --volumes, and stops nothing when declined", async () => {
    const run = await down("--volumes")
    expect(calls.compose).toEqual([])
    expect(run.output).toMatch(/nothing/i)
  })

  it("removes them when the confirmation is accepted", async () => {
    calls.answer = true
    await down("--volumes")
    expect(calls.compose).toEqual([["down", "--volumes", "--remove-orphans"]])
  })

  // 0.9.2 round 2 (R2-S20): after a switch to S3 the SeaweedFS container and its volume are no
  // longer in the compose file. `down --volumes` left both and still said the stored files were gone.
  it("says which of the stack's volumes are left, rather than that the stored files are gone", async () => {
    calls.left = ["supatype-acme_storage-data"]
    const run = await down("--volumes", "--yes")
    expect(run.output).not.toMatch(/stored files are gone/)
    expect(run.output).toContain("supatype-acme_storage-data")
    expect(run.output).toContain("docker volume rm supatype-acme_storage-data")
  })

  it("says the database and stored files are gone when no volume of the stack is left", async () => {
    const run = await down("--volumes", "--yes")
    expect(run.output).toMatch(/the database and stored files are gone/)
  })
})
