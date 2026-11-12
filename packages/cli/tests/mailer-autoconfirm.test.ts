import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { upsertDevComposeEnv } from "../src/dev-compose.js"
import { MANAGED_MARKER, readDotEnvFiles, readEnvValue } from "../src/env-file.js"
import { retireCliMailerAutoconfirm } from "../src/mailer-autoconfirm.js"
import { nativeServerDotEnvLayer } from "../src/native-dev-env.js"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"

/**
 * EM3: a dev stack could not be made to send confirmation emails, until
 * `auth.email.enableConfirmations` decided it for dev, native dev and the self-host compose file.
 *
 * FF7 (0.9.1 release test): the CLI wrote that decision into `.env` under the managed marker and
 * rewrote the line on every start, so editing it, as the auth docs said to, was undone by the next
 * `compose restart`. The CLI no longer writes it: the compose file's `${...:-default}` and native
 * dev's environment carry the config's value, and any line in `.env` is the developer's and wins.
 * The line an earlier CLI wrote is taken out once, with one line saying so.
 */

const KEY = "SUPATYPE_MAILER_AUTOCONFIRM"
const BASE = { project: { name: "demo" }, server: { mode: "dev" }, app: { mode: "none" }, database: { provider: "docker" } }
const dirs: string[] = []
let logged: string[] = []

beforeEach(() => {
  logged = []
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.join(" "))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
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

/** What a Docker dev start does to `.env`: the old line out, then the dev values written. */
const dev = (cwd: string, cfg: SupatypeProjectConfig): void => {
  retireCliMailerAutoconfirm(cwd)
  upsertDevComposeEnv(cwd, cfg, "anon-key", "service-key", 54321)
}
const value = (cwd: string): string => readEnvValue(cwd, KEY, "<unset>")
const envText = (cwd: string): string => readFileSync(join(cwd, ".env"), "utf8")
const told = (): string[] => logged.filter((line) => line.includes(KEY))

describe("supatype dev (docker)", () => {
  it("writes no SUPATYPE_MAILER_AUTOCONFIRM into .env, whatever the config says", () => {
    for (const cfg of [config(), config(true), config(false)]) {
      const cwd = project("")
      dev(cwd, cfg)
      expect(value(cwd)).toBe("<unset>")
    }
    expect(told()).toEqual([])
  })

  it("takes out the line an earlier CLI wrote under the marker, once, and says so in one line", () => {
    const cwd = project(`${MANAGED_MARKER}\n${KEY}=false\n`)
    dev(cwd, config())
    expect(value(cwd)).toBe("<unset>")
    expect(envText(cwd)).not.toContain(`${MANAGED_MARKER}\n${KEY}`)
    expect(told()).toHaveLength(1)
    expect(told()[0]).toContain("auth.email.enableConfirmations")
  })

  it("takes out the unmarked true a CLI from before the marker wrote", () => {
    const cwd = project(`${KEY}=true\n`)
    dev(cwd, config(true))
    expect(value(cwd)).toBe("<unset>")
    expect(told()).toHaveLength(1)
  })

  it("leaves a value the developer wrote, and does it all only once", () => {
    const own = project(`${KEY}=false\n`)
    dev(own, config())
    expect(value(own)).toBe("false")

    const cwd = project(`${MANAGED_MARKER}\n${KEY}=true\n`)
    dev(cwd, config())
    writeFileSync(join(cwd, ".env"), `${envText(cwd)}${KEY}=true\n`, "utf8")
    dev(cwd, config())
    expect(value(cwd)).toBe("true")
    expect(told()).toHaveLength(1)
  })
})

describe("supatype dev (native)", () => {
  /** What the server is started with, `.env` and `.env.local` read as native dev reads them. */
  const native = (cwd: string, cfg: SupatypeProjectConfig): string | undefined =>
    nativeServerDotEnvLayer({ dotEnv: readDotEnvFiles(cwd), config: cfg, denoPort: 54330 })[KEY]

  it("runs the server with the config's value when .env does not set it", () => {
    expect(native(project(""), config())).toBe("true")
    expect(native(project(""), config(true))).toBe("false")
    expect(native(project(`${KEY}=\n`), config(true))).toBe("false")
  })

  it("lets the developer's own .env or .env.local value win, true included", () => {
    expect(native(project(`${KEY}=false\n`), config())).toBe("false")
    expect(native(project(`${KEY}=true\n`), config(true))).toBe("true")
    const cwd = project("")
    writeFileSync(join(cwd, ".env.local"), `  ${KEY}=true\n`, "utf8")
    expect(native(cwd, config(true))).toBe("true")
  })
})

/**
 * 0.9.2 (D6): a self-hosted stack auto-confirmed every sign-up unless the config said otherwise, so
 * anyone could sign up with an address they do not own. Self-host now sends confirmation links by
 * default; a dev stack, which the docker path renders from the same template, still confirms at once.
 */
describe("self-host compose", () => {
  const render = (cfg: SupatypeProjectConfig, devLocal = false): string =>
    renderSelfHostCompose(cfg, process.cwd(), { devLocal })

  it("sends confirmation links when the config does not say", () => {
    expect(render(config())).toContain(`${KEY}: \${${KEY}:-false}`)
  })

  it("auto-confirms in the dev render of the same file", () => {
    expect(render(config(), true)).toContain(`${KEY}: \${${KEY}:-true}`)
  })

  it("falls back to the config's value either way, still overridable from .env", () => {
    expect(render(config(true))).toContain(`${KEY}: \${${KEY}:-false}`)
    expect(render(config(true), true)).toContain(`${KEY}: \${${KEY}:-false}`)
    expect(render(config(false))).toContain(`${KEY}: \${${KEY}:-true}`)
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
