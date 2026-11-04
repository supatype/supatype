import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeAppViteEnv } from "../src/app-vite-env.js"
import { readEnvFile } from "../src/env-file.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Issue 23: native dev wrote `VITE_SUPATYPE_URL=http://localhost:<port>` to `.env.local`, which a
 * production Vite build reads, so the local address shipped in the bundle. The URL goes to
 * `.env.development.local`, and the local stack's anon key with it.
 */
const URL = "http://localhost:18473"
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-app-vite-env-"))
  writeFileSync(join(dir, "package.json"), "{}\n")
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("native dev's front-end env", () => {
  it("writes the URL and the anon key to .env.development.local", () => {
    writeAppViteEnv(dir, projectConfig(), URL, "anon")
    expect(readEnvFile(dir, ".env.development.local")["VITE_SUPATYPE_URL"]).toBe(URL)
    expect(readEnvFile(dir, ".env.development.local")["VITE_SUPATYPE_ANON_KEY"]).toBe("anon")
    expect(readEnvFile(dir, ".env.local")).toEqual({})
  })

  it("takes what it used to write out of .env.local", () => {
    writeFileSync(join(dir, ".env.local"), `VITE_SUPATYPE_URL=${URL}\nVITE_SUPATYPE_ANON_KEY=anon\nMINE=1\n`)
    writeAppViteEnv(dir, projectConfig(), URL, "anon")
    expect(readEnvFile(dir, ".env.local")).toEqual({ MINE: "1" })
  })
})
