import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { recordNativeFunctions } from "../src/route-manifest.js"
import { parseJsonAs } from "./support/json.js"

/**
 * Local test E: `init` writes the compose stack's manifest, naming `functions-worker:8001`. Native
 * dev never wrote its own functions route, so the server proxied every function to a host that
 * does not resolve outside Docker and answered 502.
 */

const INIT_MANIFEST = {
  schema: "public",
  postgrest_url: "http://postgrest:3000",
  storage_url: "http://storage:5000",
  realtime_enabled: true,
  realtime_url: "http://realtime:4000",
  functions_enabled: true,
  functions_worker_url: "http://functions-worker:8001",
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manifestFromInit(): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-native-fn-"))
  dirs.push(dir)
  const path = join(dir, "manifest.json")
  writeFileSync(path, JSON.stringify(INIT_MANIFEST), "utf8")
  return path
}

function read(path: string): Record<string, unknown> {
  return parseJsonAs(readFileSync(path, "utf8"), isJsonObject)
}

describe("recordNativeFunctions", () => {
  it("drops the compose worker so the server routes to the Deno it runs itself", () => {
    const path = manifestFromInit()
    recordNativeFunctions(path, true)
    const manifest = read(path)
    expect(manifest).not.toHaveProperty("functions_worker_url")
    expect(manifest["functions_enabled"]).toBe(true)
    expect(manifest["schema"]).toBe("public")
  })

  it("switches functions off when native dev runs no Deno", () => {
    const path = manifestFromInit()
    recordNativeFunctions(path, false)
    const manifest = read(path)
    expect(manifest).not.toHaveProperty("functions_worker_url")
    expect(manifest["functions_enabled"]).toBe(false)
  })
})
