import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveProjectApiUrl } from "../src/resolve-api-url.js"

describe("resolveProjectApiUrl()", () => {
  it("prefers PUBLIC_SUPATYPE_URL from .env (docker dev)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-api-url-"))
    writeFileSync(
      join(cwd, ".env"),
      "PUBLIC_SUPATYPE_URL=http://localhost:18473\nPORT=54321\n",
      "utf8",
    )
    expect(resolveProjectApiUrl(cwd)).toBe("http://localhost:18473")
  })

  it("uses SUPATYPE_KONG_PORT when no URL env is set", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-api-url-"))
    writeFileSync(join(cwd, ".env"), "SUPATYPE_KONG_PORT=19200\nPORT=54321\n", "utf8")
    expect(resolveProjectApiUrl(cwd)).toBe("http://localhost:19200")
  })
})

// SITE_URL is the app's address, where auth emails send people, not the API's. Read as the API, a
// fresh init's `http://localhost:3000` sent `functions invoke --local` and the cache admin to the app.
describe("resolveProjectApiUrl() and SITE_URL", () => {
  it("is not the API's address", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-api-url-"))
    writeFileSync(join(cwd, ".env"), "SITE_URL=http://localhost:3000\nSUPATYPE_KONG_PORT=19000\n", "utf8")
    expect(resolveProjectApiUrl(cwd)).toBe("http://localhost:19000")
  })
})
