import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { recordNativeRoutes } from "../src/route-manifest.js"
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

function patchManifest(path: string, fields: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ ...read(path), ...fields }), "utf8")
}

function read(path: string): Record<string, unknown> {
  return parseJsonAs(readFileSync(path, "utf8"), isJsonObject)
}

describe("recordNativeRoutes", () => {
  it("drops the compose worker so the server routes to the Deno it runs itself", () => {
    const path = manifestFromInit()
    recordNativeRoutes(path, true)
    const manifest = read(path)
    expect(manifest).not.toHaveProperty("functions_worker_url")
    expect(manifest["functions_enabled"]).toBe(true)
    expect(manifest["schema"]).toBe("public")
  })

  // Local test N2: init's manifest kept `postgrest_url: http://postgrest:3000`, which the server reads
  // ahead of SUPATYPE_POSTGREST_URL, so native dev answered every /rest/v1 call 502 with "lookup
  // postgrest: no such host". No address of a compose service may outlive the switch to native.
  it("drops every service address a Docker stack wrote", () => {
    const path = manifestFromInit()
    patchManifest(path, { graphql_url: "http://postgrest:3000", function_worker_urls: { a: "http://fn-a:8001" } })
    recordNativeRoutes(path, true)
    const manifest = read(path)
    const urls = Object.entries(manifest).filter(([key]) => key.endsWith("_url") || key.endsWith("_urls"))
    expect(urls).toEqual([])
    expect(manifest["schema"]).toBe("public")
  })

  it("switches functions off when native dev runs no Deno", () => {
    const path = manifestFromInit()
    recordNativeRoutes(path, false)
    const manifest = read(path)
    expect(manifest).not.toHaveProperty("functions_worker_url")
    expect(manifest["functions_enabled"]).toBe(false)
  })
})
