import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { nativeServerCoreEnv } from "../src/native-dev-env.js"
import { denoServeEnv } from "../src/commands/functions.js"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * Deno colours the text of an error, a missing module's location among it, whether or not it
 * writes to a terminal, and a function's error reaches a client as JSON, escape codes and all. The
 * routers strip them; every Deno the CLI or compose starts is now told not to write them at all.
 */
const config: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
}

let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-deno-no-color-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The `functions-worker` service's block of a compose file. */
function workerBlock(compose: string): string {
  const lines = compose.split("\n")
  const start = lines.indexOf("  functions-worker:")
  const end = lines.slice(start + 1).findIndex((line) => /^ {2}[a-z][a-z0-9-]*:$/.test(line) || /^[a-z]/.test(line))
  return lines.slice(start, start + 1 + end).join("\n")
}

describe("every Deno the CLI starts", () => {
  it("is told NO_COLOR by native dev, through the server that runs it", () => {
    const env = nativeServerCoreEnv({
      mode: "dev",
      valkeyAddr: "",
      projectRef: "acme",
      manifestPath: join(dir, "manifest.json"),
      adminConfigPath: join(dir, "admin.json"),
      postgrestPort: "3001",
      pgBinDir: null,
      databaseUrl: "postgres://postgres:pw@127.0.0.1:5432/acme",
    })
    expect(env["NO_COLOR"]).toBe("1")
  })

  it("is told NO_COLOR by functions serve", () => {
    expect(denoServeEnv(dir, join(dir, "functions"), config, { port: "8001", host: "127.0.0.1" })["NO_COLOR"]).toBe("1")
  })

  it("is told NO_COLOR in the compose functions worker", () => {
    expect(workerBlock(renderSelfHostCompose(config, dir))).toContain('NO_COLOR: "1"')
  })
})
