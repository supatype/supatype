import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { localPublicApiUrl } from "../src/local-gateway.js"

/**
 * `supatype functions serve` runs functions on the host, against the local stack. Their
 * `ctx.publicUrl` is the address that stack publishes, from the same .env value compose hands the
 * server and the functions worker, not a port assumed from the default.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe("the public URL for functions run on the host", () => {
  it("is API_EXTERNAL_URL from .env, which dev writes", () => {
    const cwd = tempDir("supatype-public-url-host-")
    writeFileSync(join(cwd, ".env"), "API_EXTERNAL_URL=http://localhost:54400/\n", "utf8")
    expect(localPublicApiUrl(cwd)).toBe("http://localhost:54400")
  })

  it("falls back to the gateway's port when .env names no address", () => {
    const cwd = tempDir("supatype-public-url-port-")
    writeFileSync(join(cwd, ".env"), "SUPATYPE_KONG_PORT=54401\n", "utf8")
    expect(localPublicApiUrl(cwd)).toBe("http://localhost:54401")
  })
})
