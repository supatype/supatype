import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CONFIG_MAILER_ENV_KEYS, configMailerEnv, syncConfigMailerEnv } from "../src/config-mailer-env.js"
import { readEnvFile } from "../src/env-file.js"
import { retireCliMailerAutoconfirm } from "../src/mailer-autoconfirm.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * Issues 74 and 75: `dev` wrote the mailer values from the config with `supatype.local.config.ts`
 * laid over it, and `self-host compose up` wrote none, so production started with dev's mail
 * catcher and dev's last autoconfirm. Each command now writes them from the config it starts with.
 */
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-mailer-env-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function config(email: SupatypeProjectConfig["email"], confirmations = false): SupatypeProjectConfig {
  const built: SupatypeProjectConfig = {
    project: { name: "acme" },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
    ...(email !== undefined && { email }),
    auth: { email: { enableConfirmations: confirmations } },
  }
  return built
}

const LOCAL = config({ provider: "smtp", smtp: { host: "host.docker.internal", port: 18625, admin_email: "dev@acme.test" } })

describe("syncConfigMailerEnv", () => {
  it("takes out the SMTP values the local config gave when the committed one has none", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\nSUPATYPE_SMTP_HOST=\nSUPATYPE_SMTP_PORT=587\n")
    syncConfigMailerEnv(dir, LOCAL)
    expect(readEnvFile(dir)["SUPATYPE_SMTP_HOST"]).toBe("host.docker.internal")

    syncConfigMailerEnv(dir, config({ provider: "smtp" }))
    const env = readEnvFile(dir)
    expect(env["SUPATYPE_SMTP_HOST"]).toBeUndefined()
    expect(env["SUPATYPE_SMTP_PORT"]).toBeUndefined()
    expect(env["SUPATYPE_SMTP_ADMIN_EMAIL"]).toBeUndefined()
    expect(env["JWT_SECRET"]).toBe("s")
  })

  it("leaves a value the developer wrote by hand", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_SMTP_HOST=smtp.acme.test\n")
    syncConfigMailerEnv(dir, config({ provider: "smtp" }))
    expect(readEnvFile(dir)["SUPATYPE_SMTP_HOST"]).toBe("smtp.acme.test")
  })

  // FF7: autoconfirm reaches the server from the compose file's fallback, not from .env, so the
  // marked line the last dev wrote is taken out, as self-host compose does before this, and nothing
  // takes its place.
  it("writes no autoconfirm, and takes out the one the last dev wrote", () => {
    writeFileSync(join(dir, ".env"), "# supatype:managed, value from supatype.config.ts\nSUPATYPE_MAILER_AUTOCONFIRM=true\n")
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    retireCliMailerAutoconfirm(dir)
    syncConfigMailerEnv(dir, config(undefined, true))
    expect(readEnvFile(dir)["SUPATYPE_MAILER_AUTOCONFIRM"]).toBeUndefined()
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain("# supatype:managed, value from supatype.config.ts\nSUPATYPE_MAILER_AUTOCONFIRM")
    vi.restoreAllMocks()
  })
})

describe("CONFIG_MAILER_ENV_KEYS", () => {
  // A name the config can give that is missing here is never marked, so a local value leaks again.
  it("names every value a fully set mailer config gives", () => {
    const full = config({
      provider: "smtp",
      smtp: { host: "h", port: 1, user: "u", pass: "p", admin_email: "a@b.c", sender_name: "s" },
    }, true)
    for (const key of Object.keys(configMailerEnv(full).updates)) expect(CONFIG_MAILER_ENV_KEYS).toContain(key)
  })
})
