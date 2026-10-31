import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest, type Server } from "node:http"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CONTROL_PLANE_SECRET_HEADER } from "../../self-host-control/src/auth.js"
import { createControlPlaneServer } from "../../self-host-control/src/server.js"
import { setDockerRunnerForTests } from "../../self-host-control/src/worker.js"
import { registerFunctions } from "../src/commands/functions.js"
import { runCommand, tempProject } from "./support/command-run.js"
import { portOf } from "./support/ports.js"

/**
 * `supatype functions env unset` on a project linked to a self-host stack was refused: the control
 * plane had no `DELETE /projects/:ref/functions/env/:key`. Here the CLI's call goes, through a
 * stand-in for the gateway (/platform/v1 off, the control plane's secret on, as the server does), to
 * the stack's real control plane.
 */
const SECRET = "functions-env-self-host-test-secret-01234567"
let project: { dir: string; remove: () => void }
const servers: Server[] = []
const restarts: string[][] = []
const docker = { down: false }

function listen(server: Server): Promise<string> {
  servers.push(server)
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${portOf(server)}`)))
}

function gateway(controlPlane: string): Server {
  return createServer((req, res) => {
    const target = new URL((req.url ?? "/").replace(/^\/platform\/v1/, ""), controlPlane)
    const upstream = httpRequest(target, { method: req.method, headers: { ...req.headers, [CONTROL_PLANE_SECRET_HEADER]: SECRET } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    req.pipe(upstream)
  })
}

beforeEach(async () => {
  project = tempProject("functions-env-self-host")
  const stackDir = join(project.dir, "stack")
  mkdirSync(join(stackDir, ".supatype"), { recursive: true })
  writeFileSync(join(stackDir, ".supatype", "function-env.json"), JSON.stringify({ API_KEY: "x", KEEP: "y" }))
  vi.stubEnv("SUPATYPE_PROJECT_ROOT", stackDir)
  vi.stubEnv("SUPATYPE_PROJECT_REF", "acme")
  vi.stubEnv("COMPOSE_PROJECT_NAME", "supatype-acme")
  setDockerRunnerForTests(async (args) => {
    if (docker.down) return { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
    if (args[0] === "restart") restarts.push([...args])
    return { status: 0, stdout: args[0] === "ps" ? "worker-1" : "", stderr: "" }
  })
  const apiUrl = await listen(gateway(await listen(createControlPlaneServer(SECRET))))
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
    version: 1,
    kind: "self-host",
    projectRef: "acme",
    defaultEnvironment: "production",
    environments: { production: { name: "production", apiUrl, token: "svc-key", linkedAt: "2026-01-01T00:00:00Z" } },
  }))
})

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  restarts.length = 0
  docker.down = false
  setDockerRunnerForTests(null)
  vi.unstubAllEnvs()
  project.remove()
})

describe("functions env unset on a self-host link", () => {
  it("removes the key on the stack and restarts its worker", async () => {
    const run = await runCommand(registerFunctions, ["functions", "env", "unset", "API_KEY"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(run.output).toContain("Removed API_KEY for project acme.")
    expect(JSON.parse(readFileSync(join(project.dir, "stack", ".supatype", "function-env.json"), "utf8"))).toEqual({ KEEP: "y" })
    expect(restarts).toEqual([["restart", "-t", "10", "worker-1"]])
  }, 30_000)
})

// When the stack's Docker cannot be reached and a call needed nothing restarted, the control plane
// answers with a warning rather than failing; the CLI says it, and the command still succeeds.
describe("a self-host call whose stack cannot reach Docker, with nothing to restart", () => {
  const commands = [
    ["functions", "env", "unset", "NEVER_SET"],
    ["functions", "env", "set", "KEEP=y"],
    ["functions", "delete", "never-deployed"],
  ]
  for (const args of commands) {
    it(`says the warning and succeeds: ${args.join(" ")}`, async () => {
      await runCommand(registerFunctions, ["functions", "env", "unset", "API_KEY"], project.dir)
      docker.down = true
      const run = await runCommand(registerFunctions, args, project.dir)
      expect(run.exitCode).toBeUndefined()
      expect(run.output).toContain("Docker could not be asked whether the functions worker is running: Cannot connect to the Docker daemon")
    }, 30_000)
  }
})
