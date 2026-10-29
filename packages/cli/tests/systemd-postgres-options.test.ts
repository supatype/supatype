import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { generateUnits } from "../src/systemd.js"
import { projectConfig } from "./support/project-config.js"

/**
 * The systemd unit is the third way the CLI starts a native Postgres, beside `supatype dev` and
 * `supatype pg start`, and it started one with none of their settings: wal_level stayed at
 * `replica`, so realtime could not stream changes on a bare-metal deployment either.
 */
let dir = ""

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("the systemd Postgres unit", () => {
  it("starts Postgres with the settings native dev starts it with", () => {
    dir = mkdtempSync(join(tmpdir(), "supatype-systemd-"))
    const { postgres } = generateUnits(projectConfig(), dir, { outputDir: dir, user: "app" })
    const unit = readFileSync(postgres, "utf8")
    expect(unit).toMatch(/-o "[^"]*-c wal_level=logical[^"]*"/)
    expect(unit).toMatch(/-o "[^"]*-c max_worker_processes=16[^"]*"/)
  })
})
