/**
 * What native `supatype dev` lets supatype-server inherit from this CLI's own environment (e2e
 * 2026-11-21, RB-2).
 *
 * The server was spawned with `{ ...process.env, ...serverEnv }`, the developer's whole shell, and
 * passed all of it on to the Deno worker that runs functions. A cloud token or an API key in the
 * shell was then a `Deno.env.get` away for any function, an npm dependency's included.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { nativeServerDotEnvLayer, nativeServerInheritsEnv } from "../src/native-dev-env.js"
import { ProcessManager } from "../src/process-manager.js"
import { validateProjectConfig } from "../src/project-config.js"

describe("nativeServerInheritsEnv", () => {
  it("keeps what the server and its Deno need to run", () => {
    for (const name of [
      "PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMPDIR", "HTTPS_PROXY",
      "SSL_CERT_FILE", "DENO_DIR", "SUPATYPE_LOG_LEVEL", "AWS_REGION", "AWS_PROFILE",
    ]) {
      expect(nativeServerInheritsEnv(name), name).toBe(true)
    }
  })

  it("drops the rest of the shell", () => {
    for (const name of ["JWT_SECRET", "POSTGRES_PASSWORD", "GITHUB_TOKEN", "OPENAI_API_KEY", "SOME_SHELL_VARIABLE"]) {
      expect(nativeServerInheritsEnv(name), name).toBe(false)
    }
  })
})

describe("ProcessManager inheritEnv", () => {
  let dir = ""

  afterEach(() => {
    delete process.env["SOME_SHELL_VARIABLE"]
    rmSync(dir, { recursive: true, force: true })
  })

  /** The child's view of `names`, one `name=value` line each, started with `inheritEnv`. */
  async function childSees(names: string[], inheritEnv?: (name: string) => boolean): Promise<string[]> {
    dir = mkdtempSync(join(tmpdir(), "supatype-pm-env-"))
    const lines: string[] = []
    let stopped: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      stopped = resolve
    })
    const script = `for (const n of ${JSON.stringify(names)}) console.log(n + "=" + (process.env[n] ?? "unset"))`
    const proc = new ProcessManager(process.execPath, ["-e", script], {
      label: "env",
      pidDir: dir,
      env: { EXPLICIT: "given" },
      onLine: (line) => lines.push(line),
      onStopped: () => stopped(),
      ...(inheritEnv !== undefined && { inheritEnv }),
    })
    proc.start()
    await done
    await proc.stop()
    return lines
  }

  it("starts the process without the variables the filter refuses, and with its own env", async () => {
    process.env["SOME_SHELL_VARIABLE"] = "secret"
    const lines = await childSees(["SOME_SHELL_VARIABLE", "EXPLICIT"], nativeServerInheritsEnv)
    expect(lines).toEqual(["SOME_SHELL_VARIABLE=unset", "EXPLICIT=given"])
  }, 10_000)

  it("inherits the whole environment when no filter is given", async () => {
    process.env["SOME_SHELL_VARIABLE"] = "secret"
    const lines = await childSees(["SOME_SHELL_VARIABLE", "EXPLICIT"])
    expect(lines).toEqual(["SOME_SHELL_VARIABLE=secret", "EXPLICIT=given"])
  }, 10_000)
})

describe("nativeServerDotEnvLayer: ctx.dbUrl", () => {
  const config = validateProjectConfig(
    { project: { name: "env-test" }, database: { provider: "native" }, server: { mode: "dev" }, app: { mode: "none" } },
    "supatype.config.ts",
  )

  it("hands the worker .env's SUPATYPE_FUNCTIONS_DB_URL as SUPATYPE_DB_URL", () => {
    const layer = nativeServerDotEnvLayer({
      dotEnv: { SUPATYPE_FUNCTIONS_DB_URL: "postgresql://reader@127.0.0.1/app" },
      config,
      denoPort: 18001,
    })
    expect(layer["SUPATYPE_DB_URL"]).toBe("postgresql://reader@127.0.0.1/app")
  })

  it("leaves it off when .env does not set it, whatever .env calls SUPATYPE_DB_URL", () => {
    const layer = nativeServerDotEnvLayer({ dotEnv: { SUPATYPE_DB_URL: "postgresql://admin@127.0.0.1/app" }, config, denoPort: 18001 })
    expect(layer["SUPATYPE_DB_URL"]).toBe("")
  })
})
