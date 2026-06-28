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
