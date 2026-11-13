import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import type { DeployTarget } from "../src/resolve-target.js"
import { TargetApiError } from "../src/target-client.js"

interface Call {
  path: string
  method: string
  body: unknown
  environment: string | undefined
}

const calls: Call[] = []
let respond: (call: Call) => unknown = () => ({})

vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async (_base: string, _prefix: string, opts: { path: string; method: string; body?: unknown; environment?: string }) => {
    const call: Call = { path: opts.path, method: opts.method, body: opts.body, environment: opts.environment }
    calls.push(call)
    return respond(call)
  },
}))

const { pushAuthSettings, assertCloudAuthSettings } = await import("../src/auth-settings-push.js")

/**
 * `supatype push` to a Cloud target sends the project's auth and email settings, and the secrets the
 * config points at with `env("NAME")` resolved on this machine, to
 * `PUT /projects/:ref/environments/:env/auth/code`. It must say what was masked by Studio and what
 * secret was kept, and never print a secret.
 */
const GITHUB_SECRET = "gh-secret-value-that-must-never-be-printed"

const cloud: DeployTarget = {
  mode: "cloud",
  environment: "production",
  projectRef: "demo",
  apiBaseUrl: "https://api.example.test",
  apiPrefix: "/platform/v1",
  token: "tok",
  link: null,
}

const selfHost: DeployTarget = { ...cloud, mode: "self-host" }

function config(extra: Record<string, unknown>): SupatypeProjectConfig {
  return validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "standalone" },
      app: { mode: "none" },
      database: { provider: "docker" },
      ...extra,
    },
    "supatype.config.ts",
  )
}

const withGithub = (): SupatypeProjectConfig =>
  config({
    auth: {
      siteUrl: "https://app.example.com",
      redirectUrls: ["https://app.example.com/**"],
      disableSignup: true,
      providers: { github: { clientId: "gh-client", secret: "env(GITHUB_SECRET)" } },
    },
    email: { provider: "smtp", smtp: { host: "smtp.example.com", pass: "env(SMTP_PASS)" }, ses_from: "a@example.com" },
  })

const literalPass = (): SupatypeProjectConfig =>
  config({ email: { provider: "smtp", smtp: { host: "smtp.example.com", pass: "literal-password" } } })

const okAnswer = (extra: Record<string, unknown> = {}) => ({ view: {}, maskedFields: [], keptSecrets: [], applied: true, ...extra })

let said: string[] = []
let cwd = ""

beforeEach(() => {
  cwd = join(tmpdir(), `supatype-auth-push-${process.pid}-${Date.now()}`)
  mkdirSync(cwd, { recursive: true })
  calls.length = 0
  respond = () => okAnswer()
  said = []
  process.exitCode = undefined
  for (const method of ["log", "error", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = undefined
  rmSync(cwd, { recursive: true, force: true })
})

const text = (): string => said.join("\n")
const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  GITHUB_SECRET,
  SMTP_PASS: "smtp-secret-value",
  ...extra,
})

describe("push to Cloud sends the auth settings", () => {
  it("PUTs settings and the resolved secrets to the environment's auth/code route, and says applied", async () => {
    const failed = await pushAuthSettings(cwd, withGithub(), cloud, { environment: env() })
    expect(failed).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("PUT")
    expect(calls[0]?.path).toBe("/projects/demo/environments/production/auth/code")
    const body = calls[0]?.body as {
      settings: { auth: { siteUrl: string; disableSignup: boolean } }
      secrets: Record<string, string>
      resetOverrides: boolean
    }
    expect(body.settings.auth.siteUrl).toBe("https://app.example.com")
    expect(body.settings.auth.disableSignup).toBe(true)
    expect(body.secrets).toEqual({ "providers.github.secret": GITHUB_SECRET, "email.smtp.pass": "smtp-secret-value" })
    expect(body.resetOverrides).toBe(false)
    expect(text()).toContain("applied")
    expect(text()).not.toContain("not yet applied")
  })

  it("says written, not yet applied, when the running server has not picked it up", async () => {
    respond = () => okAnswer({ applied: false })
    await pushAuthSettings(cwd, withGithub(), cloud, { environment: env() })
    expect(text()).toContain("written, not yet applied")
  })

  it("sends resetOverrides when asked", async () => {
    await pushAuthSettings(cwd, withGithub(), cloud, { environment: env(), resetOverrides: true })
    expect((calls[0]?.body as { resetOverrides: boolean }).resetOverrides).toBe(true)
  })

  it("resolves a reference from the shell first, then .env", async () => {
    writeFileSync(join(cwd, ".env"), "GITHUB_SECRET=from-dotenv\nSMTP_PASS=smtp-from-dotenv\n")
    vi.stubEnv("GITHUB_SECRET", "from-shell")
    vi.stubEnv("SMTP_PASS", undefined)
    await pushAuthSettings(cwd, withGithub(), cloud)
    expect((calls[0]?.body as { secrets: Record<string, string> }).secrets).toEqual({
      "providers.github.secret": "from-shell",
      "email.smtp.pass": "smtp-from-dotenv",
    })
  })

  it("names each field Studio masks, with both values and how to clear it", async () => {
    respond = () =>
      okAnswer({ maskedFields: [{ path: "auth.providers.github.clientId", studioValue: "studio-id", codeValue: "gh-client" }] })
    await pushAuthSettings(cwd, withGithub(), cloud, { environment: env() })
    expect(text()).toContain(
      "auth.providers.github.clientId: not changed, Studio has studio-id saved (config says gh-client); reset it in Studio or push with --reset-auth-overrides",
    )
  })
})

describe("a secret the pushing machine does not have (D4)", () => {
  it("keeps the stored one, says so, and sends no value for it", async () => {
    respond = () => okAnswer({ keptSecrets: ["providers.github.secret"] })
    const failed = await pushAuthSettings(cwd, withGithub(), cloud, { environment: { SMTP_PASS: "x" } })
    expect(failed).toBe(false)
    expect(Object.keys((calls[0]?.body as { secrets: Record<string, string> }).secrets)).toEqual(["email.smtp.pass"])
    expect(text()).toContain("github.secret: GITHUB_SECRET is not set here, keeping the one stored")
  })

  it("fails the step naming the variable when none is stored", async () => {
    respond = () => {
      throw new TargetApiError("A secret is missing", 422, "missing_secret", {
        error: "missing_secret",
        missing: [{ key: "providers.github.secret", envName: "GITHUB_SECRET" }],
      })
    }
    const failed = await pushAuthSettings(cwd, withGithub(), cloud, { environment: { SMTP_PASS: "x" } })
    expect(failed).toBe(true)
    expect(process.exitCode).toBe(1)
    expect(text()).toContain("The schema was applied, but")
    expect(text()).toContain("GITHUB_SECRET")
  })

  it("fails the step on any other refusal, after the schema was applied", async () => {
    respond = () => {
      throw new Error("Forbidden")
    }
    expect(await pushAuthSettings(cwd, withGithub(), cloud, { environment: env() })).toBe(true)
    expect(process.exitCode).toBe(1)
    expect(text()).toContain("Forbidden")
    expect(text()).toContain("Run `supatype push` again")
  })
})

describe("what the step does not do", () => {
  it("refuses a literal secret for Cloud before any request", async () => {
    expect(() => assertCloudAuthSettings(literalPass(), cloud)).toThrow(/email\.smtp\.pass/)
    const failed = await pushAuthSettings(cwd, literalPass(), cloud, { environment: env() })
    expect(failed).toBe(true)
    expect(calls).toHaveLength(0)
    expect(text()).not.toContain("literal-password")
  })

  it("checks nothing and sends nothing for a self-host target", async () => {
    expect(() => assertCloudAuthSettings(literalPass(), selfHost)).not.toThrow()
    expect(await pushAuthSettings(cwd, withGithub(), selfHost, { environment: env() })).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("sends nothing for a project with no auth and no email section", async () => {
    expect(await pushAuthSettings(cwd, config({}), cloud, { environment: env() })).toBe(false)
    expect(calls).toHaveLength(0)
    expect(text()).toBe("")
  })

  it("never prints a secret value, even one the server echoes in an error", async () => {
    respond = () => {
      throw new Error(`bad request: secret ${GITHUB_SECRET} rejected`)
    }
    await pushAuthSettings(cwd, withGithub(), cloud, { environment: env() })
    expect(text()).not.toContain(GITHUB_SECRET)
    expect(text()).not.toContain("smtp-secret-value")
  })

  it("never prints a secret value on success either", async () => {
    await pushAuthSettings(cwd, withGithub(), cloud, { environment: env() })
    expect(text()).not.toContain(GITHUB_SECRET)
    expect(text()).not.toContain("smtp-secret-value")
  })
})
