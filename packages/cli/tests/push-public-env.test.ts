import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { CONTROL_PLANE_SECRET_HEADER } from "../../self-host-control/src/auth.js"
import { createControlPlaneServer } from "../../self-host-control/src/server.js"
import { deployPublicEnvToTarget } from "../src/commands/push.js"
import type { DeployTarget } from "../src/resolve-target.js"
import { portOf } from "./support/ports.js"
import { projectConfig } from "./support/project-config.js"

/**
 * A push sends the environment's `build.publicEnv` to the target after the schema, on every push.
 * Here a self-host push goes through a stand-in for the gateway to the stack's real control plane,
 * and a Cloud push to a stand-in that answers as an old server would.
 */
const SECRET = "push-public-env-test-secret-0123456789"
let tmp = ""
let projectDir = ""
const servers: Server[] = []

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

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "supatype-push-public-env-"))
  projectDir = join(tmp, "proj")
  mkdirSync(join(projectDir, ".supatype"), { recursive: true })
  writeFileSync(join(projectDir, ".supatype", "manifest.json"), JSON.stringify({ functions_enabled: true }))
  vi.stubEnv("SUPATYPE_PROJECT_ROOT", projectDir)
  vi.stubEnv("SUPATYPE_PROJECT_REF", "demo")
})

afterAll(() => {
  for (const server of servers.splice(0)) server.close()
  vi.unstubAllEnvs()
  rmSync(tmp, { recursive: true, force: true })
})

const manifest = (): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(join(projectDir, ".supatype", "manifest.json"), "utf8"))
  if (!isJsonObject(parsed)) throw new Error("the manifest is not a JSON object")
  return parsed
}

const withEnv = (publicEnv: Record<string, string | Record<string, string>>) => projectConfig({ build: { publicEnv } })

describe("push's public values", () => {
  it("reach a self-host stack's manifest, picked for the environment", async () => {
    const apiBaseUrl = await listen(gateway(await listen(createControlPlaneServer(SECRET))))
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const target: DeployTarget = { mode: "self-host", environment: "production", projectRef: "demo", apiBaseUrl, apiPrefix: "/platform/v1", token: "k", link: null }

    const failed = await deployPublicEnvToTarget(withEnv({ A: "1", B: { production: "p", staging: "s" } }), target)

    expect(failed).toBe(false)
    expect(manifest()["public_env"]).toEqual({ A: "1", B: "p" })
  }, 30_000)

  it("clear what the config stopped naming", async () => {
    const apiBaseUrl = await listen(gateway(await listen(createControlPlaneServer(SECRET))))
    const target: DeployTarget = { mode: "self-host", environment: "production", projectRef: "demo", apiBaseUrl, apiPrefix: "/platform/v1", token: "k", link: null }

    expect(await deployPublicEnvToTarget(projectConfig(), target)).toBe(false)

    expect("public_env" in manifest()).toBe(false)
  }, 30_000)

  it("end the push non-zero when the target refuses, saying what was refused", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "validation_error", message: "A is refused by the control plane" }))
    })
    const apiBaseUrl = await listen(server)
    const target: DeployTarget = { mode: "cloud", environment: "production", projectRef: "demo", apiBaseUrl, apiPrefix: "/api/v1", token: "t", link: null }
    const shown: string[] = []
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void shown.push(args.join(" ")))
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void shown.push(args.join(" ")))

    expect(await deployPublicEnvToTarget(withEnv({ A: "1" }), target)).toBe(true)
    expect(shown.join("\n")).toContain("A is refused by the control plane")
  })

  it("send nothing to a Cloud server that predates them when the config names none", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "not_found", message: "Route not found" }))
    })
    const apiBaseUrl = await listen(server)
    const target: DeployTarget = { mode: "cloud", environment: "production", projectRef: "demo", apiBaseUrl, apiPrefix: "/api/v1", token: "t", link: null }
    expect(await deployPublicEnvToTarget(projectConfig(), target)).toBe(false)
  })
})
