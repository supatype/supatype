import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClackApi } from "../src/ui/clack-api.js"

/**
 * Round 6: docker writing straight to the terminal while a command's flow held the screen landed
 * in the frame the flow redraws, and every notice above it came out twice. Inside a flow its
 * output is captured, and what it printed to stdout (`ps`'s table, say) goes into the flow's log.
 */
const docker = vi.hoisted(() => ({ stdio: [] as unknown[], stdout: "" }))
vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDockerSync: (_args: readonly string[], call: { stdio?: unknown }) => {
    docker.stdio.push(call.stdio)
    return { status: 0, stdout: docker.stdout, stderr: "", timedOut: false, missing: false }
  },
}))
vi.mock("../src/docker-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-runtime.js")>()),
  requireDockerDaemon: () => undefined,
}))
const flow = vi.hoisted(() => ({ notes: [] as string[], active: false }))
vi.mock("../src/ui/runtime/flow-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/runtime/flow-session.js")>()),
  getActiveFlowApi: (): Partial<ClackApi> | null => (flow.active ? { note: (text: string) => void flow.notes.push(text) } : null),
}))

const { runDockerCompose } = await import("../src/self-host-compose.js")

afterEach(() => {
  docker.stdio = []
  docker.stdout = ""
  flow.notes = []
})

describe("runDockerCompose", () => {
  it("captures docker's output inside a flow and logs its stdout there", () => {
    flow.active = true
    docker.stdout = "NAME   STATUS\nserver running\n"
    expect(runDockerCompose("compose.yml", ["ps"], "/project", "acme")).toBe(0)
    expect(docker.stdio).toEqual(["pipe"])
    expect(flow.notes).toEqual(["NAME   STATUS\nserver running"])
  })

  it("lets docker write to the terminal with no flow up", () => {
    flow.active = false
    runDockerCompose("compose.yml", ["ps"], "/project", "acme")
    expect(docker.stdio).toEqual(["inherit"])
  })
})
