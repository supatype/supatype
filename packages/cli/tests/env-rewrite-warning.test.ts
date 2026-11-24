import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { syncConfigMailerEnv } from "../src/config-mailer-env.js"
import { syncComposeImagePins } from "../src/dev-compose.js"
import { MANAGED_MARKER, upsertEnvFile, type HandEditedValue } from "../src/env-file.js"
import { composeDockerImageEnv } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * Finding 12 (e2e 2026-11-23): docker.mdx told people to set the mailer provider in `.env`, and
 * `compose up` wrote the config's value over it without a word. The config is the one source, so
 * the value is still replaced, but now the developer is told which key, from what, to what.
 */
let dir = ""
let warn: MockInstance<Console["warn"]>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-env-warn-"))
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  warn.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

const env = () => readFileSync(join(dir, ".env"), "utf8")
const warned = () => warn.mock.calls.map((call) => String(call[0])).join("\n")

function config(email: SupatypeProjectConfig["email"], versions?: SupatypeProjectConfig["versions"]): SupatypeProjectConfig {
  return {
    project: { name: "acme" },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
    ...(email !== undefined && { email }),
    ...(versions !== undefined && { versions }),
  }
}

describe("upsertEnvFile onHandEdited", () => {
  it("reports a hand-written managed key that gets a different value", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_MAILER_MAILER_PROVIDER=smtp\n")
    const seen: HandEditedValue[][] = []
    upsertEnvFile(dir, { SUPATYPE_MAILER_MAILER_PROVIDER: "console" }, {
      managed: ["SUPATYPE_MAILER_MAILER_PROVIDER"],
      onHandEdited: (changes) => seen.push([...changes]),
    })
    expect(seen).toEqual([[{ key: "SUPATYPE_MAILER_MAILER_PROVIDER", from: "smtp", to: "console" }]])
    expect(env()).toContain("SUPATYPE_MAILER_MAILER_PROVIDER=console")
  })

  it("stays quiet for a same value, a blank scaffold, a CLI-written line and an unmanaged key", () => {
    writeFileSync(
      join(dir, ".env"),
      ["A=same", "B=", `${MANAGED_MARKER}`, "C=old", "D=hand", ""].join("\n"),
    )
    const onHandEdited = vi.fn()
    upsertEnvFile(dir, { A: "same", B: "new", C: "new", D: "new" }, { managed: ["A", "B", "C"], onHandEdited })
    expect(onHandEdited).not.toHaveBeenCalled()
  })
})

describe("the config-derived writers warn", () => {
  it("names the mailer key, its old and new value, and says to use supatype.config.ts", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_MAILER_MAILER_PROVIDER=smtp\n")
    syncConfigMailerEnv(dir, config(undefined))
    const text = warned()
    expect(text).toContain("SUPATYPE_MAILER_MAILER_PROVIDER")
    expect(text).toContain("smtp")
    expect(text).toContain("console")
    expect(text).toContain("supatype.config.ts")
    expect(env()).toContain("SUPATYPE_MAILER_MAILER_PROVIDER=console")
  })

  it("warns once: the replaced line is the CLI's afterwards", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_MAILER_MAILER_PROVIDER=smtp\n")
    syncConfigMailerEnv(dir, config(undefined))
    warn.mockClear()
    syncConfigMailerEnv(dir, config(undefined))
    expect(warn).not.toHaveBeenCalled()
  })

  it("masks a secret-looking value in both directions", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_SMTP_PASS=hunter2-by-hand\n")
    syncConfigMailerEnv(dir, config({ provider: "smtp", smtp: { host: "h", pass: "from-config-secret" } }))
    const text = warned()
    expect(text).toContain("SUPATYPE_SMTP_PASS")
    expect(text).not.toContain("hunter2-by-hand")
    expect(text).not.toContain("from-config-secret")
    expect(text).toContain("***")
  })

  it("warns for an image pin the config overwrites", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_SERVER_IMAGE=mine/server:dev\n")
    syncComposeImagePins(dir, config(undefined, { server: "0.9.9" }))
    const text = warned()
    expect(text).toContain("SUPATYPE_SERVER_IMAGE")
    expect(text).toContain("mine/server:dev")
    expect(text).toContain(composeDockerImageEnv(config(undefined, { server: "0.9.9" })).SUPATYPE_SERVER_IMAGE)
  })
})

describe("a hand edit under the managed marker (D-98a)", () => {
  const KEY = "SUPATYPE_MAILER_MAILER_PROVIDER"
  const record = () => readFileSync(join(dir, ".supatype", "env-managed.json"), "utf8")

  /** A first run, which leaves the key under the marker and the record behind. */
  function firstRun(): void {
    syncConfigMailerEnv(dir, config(undefined))
    warn.mockClear()
  }

  it("warns, with from and to, when the line under the marker was edited in place", () => {
    firstRun()
    writeFileSync(join(dir, ".env"), env().replace(`${KEY}=console`, `${KEY}=smtp`))
    syncConfigMailerEnv(dir, config(undefined))
    const text = warned()
    expect(text).toContain(KEY)
    expect(text).toContain("smtp")
    expect(text).toContain("console")
    expect(env()).toContain(`${KEY}=console`)
  })

  it("does not warn when the line under the marker is as the CLI left it", () => {
    firstRun()
    syncConfigMailerEnv(dir, config(undefined))
    expect(warn).not.toHaveBeenCalled()
  })

  it("does not warn on the first run after an upgrade, when there is no record yet", () => {
    writeFileSync(join(dir, ".env"), `${MANAGED_MARKER}\n${KEY}=smtp\n`)
    syncConfigMailerEnv(dir, config(undefined))
    expect(warn).not.toHaveBeenCalled()
    expect(env()).toContain(`${KEY}=console`)
  })

  it("does not warn when the value changed in supatype.config.ts and not by hand", () => {
    firstRun()
    syncConfigMailerEnv(dir, config({ provider: "smtp", smtp: { host: "h", pass: "p" } }))
    expect(warn).not.toHaveBeenCalled()
    expect(env()).toContain(`${KEY}=smtp`)
  })

  it("keeps no secret value in plain text in the record", () => {
    syncConfigMailerEnv(dir, config({ provider: "smtp", smtp: { host: "h", pass: "from-config-secret" } }))
    expect(record()).toContain("SUPATYPE_SMTP_PASS")
    expect(record()).not.toContain("from-config-secret")
  })

  it("masks a secret edited in place under the marker", () => {
    syncConfigMailerEnv(dir, config({ provider: "smtp", smtp: { host: "h", pass: "from-config-secret" } }))
    warn.mockClear()
    writeFileSync(join(dir, ".env"), env().replace("from-config-secret", "hunter2-by-hand"))
    syncConfigMailerEnv(dir, config({ provider: "smtp", smtp: { host: "h", pass: "from-config-secret" } }))
    const text = warned()
    expect(text).toContain("SUPATYPE_SMTP_PASS")
    expect(text).not.toContain("hunter2-by-hand")
  })
})
