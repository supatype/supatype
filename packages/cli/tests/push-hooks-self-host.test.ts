import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { CONTROL_PLANE_SECRET_HEADER } from "../../self-host-control/src/auth.js"
import { createControlPlaneServer } from "../../self-host-control/src/server.js"
import { setDockerRunnerForTests } from "../../self-host-control/src/worker.js"
import { deployHooksToTarget, uploadHooks } from "../src/commands/push.js"
import { portOf } from "./support/ports.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Local test round 4 (N23): a push to a project linked to a self-host stack applied the schema and
 * then failed: the control plane had no `/projects/:ref/hooks/deploy`. Here the CLI's upload goes,
 * through a stand-in for the gateway (which strips /platform/v1 and adds the control plane's secret,
 * as Kong does), to the stack's real control plane.
 */
const SECRET = "push-hooks-self-host-test-secret-0123456789"
let tmp = ""
let projectDir = ""
const servers: Server[] = []

function listen(server: Server): Promise<string> {
  servers.push(server)
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${portOf(server)}`)))
}

/** The gateway's part: /platform/v1 off the path, the control plane's secret on the request. */
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

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "supatype-push-hooks-self-host-"))
  projectDir = join(tmp, "proj")
  mkdirSync(join(projectDir, ".supatype"), { recursive: true })
  writeFileSync(join(projectDir, ".supatype", "manifest.json"), JSON.stringify({ functions_enabled: true }))
  vi.stubEnv("SUPATYPE_PROJECT_ROOT", projectDir)
  vi.stubEnv("SUPATYPE_PROJECT_REF", "demo")
  vi.stubEnv("SUPATYPE_HOOKS_ROOT", join(projectDir, "hooks"))
  vi.stubEnv("COMPOSE_PROJECT_NAME", "supatype-push-hooks-self-host-test-none")
  // The worker restart, answered here: one worker container, restarted.
  setDockerRunnerForTests(async (args) => ({ status: 0, stdout: args[0] === "ps" ? "worker-1" : "", stderr: "" }))
})

afterAll(() => {
  for (const server of servers.splice(0)) server.close()
  setDockerRunnerForTests(null)
  vi.unstubAllEnvs()
  rmSync(tmp, { recursive: true, force: true })
})

describe("push's hook upload to a self-host stack", () => {
  it("is taken: the handler is where the worker serves hooks, and the server's manifest maps it", async () => {
    const controlPlane = await listen(createControlPlaneServer(SECRET))
    const apiBaseUrl = await listen(gateway(controlPlane))
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const target = { mode: "self-host", environment: "production", projectRef: "demo", apiBaseUrl, apiPrefix: "/platform/v1", token: "service-role-key", link: null } as const
    const handlers = [
      { name: "tag-note", source: 'import { hook } from "./_supatype-hooks.ts"\nexport default hook(async () => ({}))\n' },
      { name: "_supatype-hooks", source: "export const hook = (handler) => handler\n" },
    ]
    const map = { note: { beforeChange: { function: "tag-note", timeout: 5000, onUnavailable: "reject" } } }

    await uploadHooks(target, { handlers, map }, 1)

    expect(readFileSync(join(projectDir, "hooks", "tag-note", "index.ts"), "utf8")).toContain('from "../_supatype/hooks.ts"')
    const manifest: unknown = JSON.parse(readFileSync(join(projectDir, ".supatype", "manifest.json"), "utf8"))
    expect(isJsonObject(manifest) && manifest["hooks"]).toEqual(map)
  }, 30_000)

  // A linked push wrote no validator or cache map on the stack, so neither applied there, and a
  // schema with validators and no hooks sent nothing at all.
  it("sends the validator and cache maps, and the validator's function, with no hook declared", async () => {
    const controlPlane = await listen(createControlPlaneServer(SECRET))
    const apiBaseUrl = await listen(gateway(controlPlane))
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const target = { mode: "self-host", environment: "production", projectRef: "demo", apiBaseUrl, apiPrefix: "/platform/v1", token: "service-role-key", link: null } as const
    const cwd = join(tmp, "local")
    mkdirSync(join(cwd, "hooks", "check-title"), { recursive: true })
    writeFileSync(join(cwd, "hooks", "check-title", "index.ts"), "export default () => ({ ok: true })\n")
    const ast = {
      models: [
        {
          name: "Note",
          fields: {},
          annotations: {
            db: { tableName: "note" },
            platform: { validate: { title: { function: "check-title" } }, cache: { enabled: true, rows: true, maxTtl: 60 } },
          },
        },
      ],
    }

    await deployHooksToTarget(cwd, projectConfig(), target, ast)

    const manifest: unknown = JSON.parse(readFileSync(join(projectDir, ".supatype", "manifest.json"), "utf8"))
    if (!isJsonObject(manifest)) throw new Error("the manifest is not a JSON object")
    expect(manifest["validators"]).toMatchObject({ note: { title: { function: "check-title", onUnavailable: "reject" } } })
    expect(manifest["cache"]).toEqual({ note: { enabled: true, rows: true, maxTtl: 60 } })
    expect(readFileSync(join(projectDir, "hooks", "check-title", "index.ts"), "utf8")).toContain("ok: true")
  }, 30_000)
})
