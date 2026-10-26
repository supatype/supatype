import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { upsertDevComposeEnv } from "../src/dev-compose.js"
import { MANAGED_MARKER, readEnvValue } from "../src/env-file.js"
import { nativeMailerAutoconfirmEnv } from "../src/mailer-autoconfirm.js"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"

/**
 * EM3: a dev stack could not be made to send confirmation emails.
 *
 * `supatype dev` wrote `SUPATYPE_MAILER_AUTOCONFIRM=true` into `.env` on every start and no config
 * key said otherwise, so the only way to test a sign-up's confirmation email was to edit `.env`
 * after every start. `auth.email.enableConfirmations` now decides it for dev, native dev and the
 * self-host compose file, auto-confirming when it is unset as before, and a value the developer
 * wrote into `.env` themselves is left alone.
 */

const KEY = "SUPATYPE_MAILER_AUTOCONFIRM"
const BASE = { project: { name: "demo" }, server: { mode: "dev" }, app: { mode: "none" }, database: { provider: "docker" } }
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function config(enableConfirmations?: boolean): SupatypeProjectConfig {
  return validateProjectConfig({
    ...BASE,
    ...(enableConfirmations !== undefined && { auth: { email: { enableConfirmations } } }),
  }, "supatype.config.ts")
}

/** A project directory whose `.env` starts as given. */
function project(env: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "supatype-autoconfirm-"))
  dirs.push(cwd)
  writeFileSync(join(cwd, ".env"), `JWT_SECRET=x\n${env}`, "utf8")
  return cwd
}

const dev = (cwd: string, cfg: SupatypeProjectConfig): void =>
  upsertDevComposeEnv(cwd, cfg, "anon-key", "service-key", 54321)
const value = (cwd: string): string => readEnvValue(cwd, KEY, "<unset>")

describe("supatype dev (docker)", () => {
  it("auto-confirms when the config does not say", () => {
    const cwd = project("")
    dev(cwd, config())
    expect(value(cwd)).toBe("true")
  })

  it("turns auto-confirm off when the config enables confirmations", () => {
    const cwd = project("")
    dev(cwd, config(true))
    expect(value(cwd)).toBe("false")
  })

  it("replaces the true an earlier CLI wrote, which carried no marker", () => {
    const cwd = project(`${KEY}=true\n`)
    dev(cwd, config(true))
    expect(value(cwd)).toBe("false")
  })

  it("follows the config back once confirmations are turned off again", () => {
    const cwd = project("")
    dev(cwd, config(true))
    dev(cwd, config(false))
    expect(value(cwd)).toBe("true")
    expect(readFileSync(join(cwd, ".env"), "utf8").split(MANAGED_MARKER)).toHaveLength(2)
  })

  it("leaves a value the developer wrote into .env themselves", () => {
    const cwd = project(`${KEY}=false\n`)
    dev(cwd, config())
    expect(value(cwd)).toBe("false")
  })
})

describe("supatype dev (native)", () => {
  /** What the server is started with over `.env`, or undefined when `.env.local`'s value stands. */
  const native = (cwd: string, cfg: SupatypeProjectConfig): string | undefined =>
    nativeMailerAutoconfirmEnv(cwd, cfg)[KEY]

  it("runs the server with the config's value", () => {
    expect(native(project(""), config())).toBe("true")
    expect(native(project(""), config(true))).toBe("false")
    expect(native(project(`${KEY}=true\n`), config(true))).toBe("false")
  })

  it("lets the developer's own .env value win", () => {
    expect(native(project(`${KEY}=false\n`), config())).toBe("false")
  })

  it("leaves a value in .env.local, which the CLI never writes, to win", () => {
    const cwd = project("")
    writeFileSync(join(cwd, ".env.local"), `${KEY}=true\n`, "utf8")
    expect(native(cwd, config(true))).toBeUndefined()
  })
})

describe("self-host compose", () => {
  it("falls back to auto-confirm when the config does not say", () => {
    expect(renderSelfHostCompose(config())).toContain(`${KEY}: \${${KEY}:-true}`)
  })

  it("falls back to the config's value, still overridable from .env", () => {
    expect(renderSelfHostCompose(config(true))).toContain(`${KEY}: \${${KEY}:-false}`)
  })
})

describe("the config key", () => {
  it("must be a boolean", () => {
    expect(() => validateProjectConfig({
      ...BASE,
      auth: { email: { enableConfirmations: "yes" } },
    }, "supatype.config.ts")).toThrow(/auth\.email\.enableConfirmations/)
  })
})
