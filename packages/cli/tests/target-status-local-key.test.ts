import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { targetStatus, type DeployTarget } from "../src/resolve-target.js"

/**
 * A dev project that is not linked resolves to a `local` target with no token, so its schema
 * commands run the engine here. `supatype status` still asks the stack's control plane, and the
 * gateway now requires the service-role key on `/platform/v1` in dev as well (it used to wave dev
 * requests through, which let any deployed function reach the control plane). Status sent
 * `Bearer undefined` and only worked because of that hole.
 */
let dir: string
let seen: string[]
const originalFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-status-key-"))
  seen = []
  globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seen.push(headers.get("Authorization") ?? "")
    return new Response(JSON.stringify({ data: { controlPlane: "self-host" } }), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  rmSync(dir, { recursive: true, force: true })
})

function localTarget(token?: string): DeployTarget {
  return {
    mode: "local",
    environment: "local",
    projectRef: "proj",
    apiBaseUrl: "http://localhost:1",
    apiPrefix: "/platform/v1",
    link: null,
    ...(token !== undefined && { token }),
  }
}

describe("targetStatus on the local dev stack", () => {
  it("presents the service-role key the stack was configured with", async () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=x\nSERVICE_ROLE_KEY=the-stack-key\n", "utf8")
    await targetStatus(localTarget(), dir)
    expect(seen).toEqual(["Bearer the-stack-key"])
  })

  it("prefers SUPATYPE_SERVICE_ROLE_KEY in .env, as the stack's own readers do", async () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_SERVICE_ROLE_KEY=explicit\nSERVICE_ROLE_KEY=other\n", "utf8")
    await targetStatus(localTarget(), dir)
    expect(seen).toEqual(["Bearer explicit"])
  })

  it("keeps a token the target already carries", async () => {
    writeFileSync(join(dir, ".env"), "SERVICE_ROLE_KEY=the-stack-key\n", "utf8")
    await targetStatus(localTarget("from-the-environment"), dir)
    expect(seen).toEqual(["Bearer from-the-environment"])
  })

  it("never sends a token it does not have", async () => {
    await expect(targetStatus(localTarget(), dir)).rejects.toThrow(/service-role key/i)
    expect(seen).toEqual([])
  })
})
