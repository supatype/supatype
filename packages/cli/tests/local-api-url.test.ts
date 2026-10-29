import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { denoServeEnv } from "../src/commands/functions.js"
import { resolveProjectApiUrl } from "../src/resolve-api-url.js"
import { projectConfig } from "./support/project-config.js"

/**
 * One local API address for every command, by provider. A native project whose `.env` still holds
 * a Docker run's gateway (`API_EXTERNAL_URL`, `SUPATYPE_KONG_PORT`) sent `functions invoke --local`,
 * the REST cache admin and `functions serve`'s `ctx.publicUrl` to that gateway, where nothing runs.
 * Native dev has no gateway: its API is the server.
 */
const STALE_DOCKER_ENV = "API_EXTERNAL_URL=http://localhost:18490\nPUBLIC_SUPATYPE_URL=http://localhost:18490\nSUPATYPE_KONG_PORT=18490\n"
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-local-api-"))
  for (const key of ["SUPATYPE_URL", "SUPATYPE_API_URL", "SUPATYPE_PUBLIC_URL", "SUPATYPE_KONG_PORT", "API_EXTERNAL_URL"]) {
    vi.stubEnv(key, undefined)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function project(provider: "native" | "docker", port?: number): void {
  const server = port === undefined ? `{ mode: "dev" }` : `{ mode: "dev", port: ${port} }`
  writeFileSync(
    join(dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, provider: "${provider}", database: { provider: "${provider}" }, server: ${server}, app: { mode: "none" } }\n`,
    "utf8",
  )
  writeFileSync(join(dir, ".env"), STALE_DOCKER_ENV, "utf8")
}

describe("the local API address of a native project with a Docker run's .env", () => {
  it("is the native server, for invoke --local, the cache admin and link", () => {
    project("native", 18491)
    expect(resolveProjectApiUrl(dir)).toBe("http://localhost:18491")
  })

  it("is what functions serve hands its handlers as ctx.url and ctx.publicUrl", () => {
    project("native", 18491)
    const env = denoServeEnv({ cwd: dir, config: projectConfig({ provider: "native", server: { mode: "dev", port: 18491 } }), functionsDir: join(dir, "functions"), keyPath: undefined }, { port: "18472", host: "127.0.0.1" })
    expect(env["SUPATYPE_PUBLIC_URL"]).toBe("http://localhost:18491")
    expect(env["SUPATYPE_URL"]).toBe("http://localhost:18491")
  })
})

describe("the local API address of a docker project", () => {
  it("is still its gateway", () => {
    project("docker")
    expect(resolveProjectApiUrl(dir)).toBe("http://localhost:18490")
  })
})

describe("the local API address, from code review", () => {
  it("is the gateway's default port for a docker project before its first dev, never the native server's", () => {
    project("docker")
    writeFileSync(join(dir, ".env"), "", "utf8")
    expect(resolveProjectApiUrl(dir)).toBe("http://localhost:18473")
  })

  it("honours a SUPATYPE_URL the developer set, for a native project too", () => {
    project("native", 18491)
    writeFileSync(join(dir, ".env"), `${STALE_DOCKER_ENV}SUPATYPE_URL=http://api.test:9999/\n`, "utf8")
    expect(resolveProjectApiUrl(dir)).toBe("http://api.test:9999")
  })

  it("answers from .env without reading a broken config", () => {
    writeFileSync(join(dir, "supatype.config.ts"), "export default {{ not valid\n", "utf8")
    writeFileSync(join(dir, ".env"), "PUBLIC_SUPATYPE_URL=http://localhost:18490\n", "utf8")
    expect(resolveProjectApiUrl(dir)).toBe("http://localhost:18490")
  })

  it("uses the config it is given rather than loading one", () => {
    writeFileSync(join(dir, ".env"), STALE_DOCKER_ENV, "utf8")
    const native = projectConfig({ provider: "native", server: { mode: "dev", port: 18491 } })
    expect(resolveProjectApiUrl(dir, native)).toBe("http://localhost:18491")
  })
})
