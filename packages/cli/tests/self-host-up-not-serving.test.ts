import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * Issue 57: after a failed `self-host compose up`, the next `up` left a db container with no network,
 * waited two minutes on a gateway answering 502, then said "The stack is up" and exited 0. A stack
 * that never answers is now reported as not serving, with exit 1. And `up` checks the ports the stack
 * publishes before it starts anything, as `dev` and `init` do, rather than leaving Docker's "port is
 * already allocated" as the only clue.
 */
const stack = vi.hoisted(() => ({ calls: [] as string[][], serving: true, taken: [] as Array<{ service: string; port: number }> }))

vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: (cwd: string) => ({ composePath: join(cwd, "docker-compose.yml"), kongPath: "" }),
  runDockerCompose: (_path: string, args: string[]) => {
    stack.calls.push(args)
    return 0
  },
}))
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderOptions: () => ({ devLocal: false }),
}))
vi.mock("../src/compose-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-services.js")>()),
  takenComposePorts: async () => stack.taken,
}))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadSchemaAst: () => ({ version: 2, models: [] }),
}))
vi.mock("../src/dev-compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dev-compose.js")>()
  return {
    ...actual,
    provisionStartedStack: async () => {
      if (!stack.serving) {
        throw new actual.StackNotServing("Gateway at http://127.0.0.1:18520 did not become ready within 120s (auth/v1/health: HTTP 502)")
      }
    },
  }
})
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => false }))

import { registerSelfHost } from "../src/commands/self-host.js"

let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("self-host-up-not-serving")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "standalone" }, app: { mode: "none" } }\n`,
  )
  writeFileSync(join(project.dir, ".env"), ["JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef", "ANON_KEY=a", "SERVICE_ROLE_KEY=s", ""].join("\n"))
  stack.calls = []
  stack.serving = true
  stack.taken = []
})

afterEach(() => {
  process.exitCode = undefined
  project.remove()
})

describe("self-host compose up", () => {
  it("says a stack whose gateway never answers is not serving, and exits 1", async () => {
    stack.serving = false
    const run = await runCommand(registerSelfHost, ["self-host", "compose", "up"], project.dir)
    expect(process.exitCode).toBe(1)
    expect(run.output).toContain("The stack started but is not serving")
    expect(run.output).not.toContain("The stack is up")
  })

  it("refuses before starting anything when a port the stack publishes is taken", async () => {
    stack.taken = [{ service: "seaweedfs", port: 8333 }]
    const run = await runCommand(registerSelfHost, ["self-host", "compose", "up"], project.dir)
    expect(run.output).toContain("Port 8333 is already in use, and the stack's seaweedfs service publishes it.")
    expect(stack.calls).toEqual([])
  })

  it("starts as before when the ports are free and the stack answers", async () => {
    const run = await runCommand(registerSelfHost, ["self-host", "compose", "up"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(stack.calls).toEqual([["up", "-d"]])
  })
})
