import { createServer, type Server } from "node:http"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * Issue 41, as Nic decided it: nothing starts the stack implicitly any more, so `push` no longer
 * brings a stopped stack up and creates the schema's buckets and first admin on the way. `supatype
 * self-host compose up` does that now, once the stack answers, as `dev` and a push to a running
 * stack do, so no command depends on a push to start the stack.
 */
const compose = vi.hoisted(() => ({ calls: [] as string[][], admins: 0 }))

// `compose up` checks the stack's published ports first (issue 57): nothing holds them here.
vi.mock("../src/compose-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-services.js")>()),
  takenComposePorts: async () => [],
}))
vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: (cwd: string) => ({ composePath: join(cwd, "docker-compose.yml"), kongPath: "" }),
  runDockerCompose: (_path: string, args: string[]) => {
    compose.calls.push(args)
    return 0
  },
}))
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderOptions: () => ({ devLocal: false }),
}))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadSchemaAst: () => ({ version: 2, models: [], storageBuckets: [{ id: "avatars" }] }),
}))
vi.mock("../src/commands/admin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands/admin.js")>()),
  ensureFirstAdminUserForProject: async () => {
    compose.admins += 1
  },
}))
// The stack's containers, as `compose ps` lists them: all running.
vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDocker: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false, missing: false }),
}))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => false }))

import { registerSelfHost } from "../src/commands/self-host.js"

let project: { dir: string; remove: () => void }
let gateway: Server
let created: string[] = []

/** Kong in front of a healthy stack: every health route answers, and storage takes new buckets. */
function startGateway(): Promise<number> {
  gateway = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk: Buffer) => (body += chunk.toString()))
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/storage/v1/bucket") created.push(body)
      res.writeHead(200, { "Content-Type": "application/json" }).end(req.method === "GET" && req.url?.startsWith("/storage/v1/bucket") ? "[]" : "{}")
    })
  })
  return new Promise((done) =>
    gateway.listen(0, "127.0.0.1", () => {
      const address = gateway.address()
      done(address !== null && typeof address !== "string" ? address.port : 0)
    }),
  )
}

beforeEach(async () => {
  project = tempProject("self-host-up-provisions")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "standalone" }, app: { mode: "none" } }\n`,
  )
  const port = await startGateway()
  const env = ["JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef", "ANON_KEY=a", "SERVICE_ROLE_KEY=s", `SUPATYPE_KONG_PORT=${port}`, ""]
  writeFileSync(join(project.dir, ".env"), env.join("\n"))
  compose.calls = []
  compose.admins = 0
  created = []
})

afterEach(async () => {
  await new Promise<void>((done) => gateway.close(() => done()))
  project.remove()
})

describe("self-host compose up", () => {
  it("creates the schema's buckets and the first admin once the stack answers", async () => {
    const run = await runCommand(registerSelfHost, ["self-host", "compose", "up"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(compose.calls).toEqual([["up", "-d"]])
    expect(created.map((body): unknown => JSON.parse(body))).toEqual([expect.objectContaining({ id: "avatars" })])
    expect(compose.admins).toBe(1)
  }, 30_000)
})
