import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openKeyspaceNotice } from "../src/cache-provider.js"
import { warnMissingStackSettings } from "../src/stack-setting-warnings.js"
import { readEnvFile } from "../src/env-file.js"
import { buildKongDeclarative } from "../src/kong-config.js"
import { keyspacePasswordOrigin, projectKeyspacePassword } from "../src/keyspace-password-file.js"
import { resolvePostgresImage, setPostgresTagCheck } from "../src/postgres-image.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { renderSelfHostCompose, selfHostComposePaths, writeSelfHostCompose } from "../src/self-host-compose.js"

/**
 * 0.9.2 release test (N-RB2): the RESP keyspace answered every client with no password. From
 * supatype/postgres 17.2.13 the image takes SUPATYPE_KEYSPACE_PASSWORD, requires AUTH and sets the
 * `supatype` credential to it on every start; the server sends it. Docker dev and self-host pass a
 * per-project password to both when the keyspace is in Postgres and the image can take it.
 */

const PASSWORD_ENV = "SUPATYPE_KEYSPACE_PASSWORD"
const REQUIRED = `${PASSWORD_ENV}: \${${PASSWORD_ENV}:?`

/** A Docker project running `pin`, its keyspace in Postgres unless `provider` says otherwise. */
function project(pin: string, provider?: "valkey" | "pg_keyspace"): SupatypeProjectConfig {
  return {
    project: { name: "acme" },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
    versions: { postgres: pin },
    ...(provider !== undefined && { cache: { provider } }),
  }
}

/** The lines of one compose service, up to the next service. */
function serviceBlock(compose: string, name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`)
  if (start < 0) throw new Error(`no ${name} service`)
  const rest = compose.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

let dirs: string[] = []
beforeEach(() => {
  dirs = []
  // Every exact tag is on this machine, so a pin runs as written.
  setPostgresTagCheck(() => "local")
})
afterEach(() => {
  setPostgresTagCheck(undefined)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A project directory with a usable .env, and `extra` lines in it. */
function projectDir(extra = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-ks-auth-"))
  dirs.push(dir)
  writeFileSync(join(dir, ".env"), `JWT_SECRET=${"j".repeat(64)}\n${extra}`, "utf8")
  return dir
}

describe("which Postgres images take a keyspace password", () => {
  it("is 17.2.13 and later, and a floating tag", () => {
    const check = (): "local" => "local"
    expect(resolvePostgresImage(project("17.2.13"), check).keyspaceAuth).toBe(true)
    expect(resolvePostgresImage(project("17.3.0"), check).keyspaceAuth).toBe(true)
    expect(resolvePostgresImage(project("17-latest"), check).keyspaceAuth).toBe(true)
    expect(resolvePostgresImage(project("17.2.12"), check).keyspaceAuth).toBe(false)
    expect(resolvePostgresImage(project("17.2.9"), check).keyspaceAuth).toBe(false)
  })
})

describe("the keyspace password in the compose file", () => {
  it("is required of the db and the server when the image takes it", () => {
    const compose = renderSelfHostCompose(project("17.2.13"), projectDir())
    expect(serviceBlock(compose, "db")).toContain(REQUIRED)
    expect(serviceBlock(compose, "server")).toContain(REQUIRED)
  })

  it("is left out for an image before 17.2.13, which would ignore it", () => {
    expect(renderSelfHostCompose(project("17.2.12"), projectDir())).not.toContain(PASSWORD_ENV)
  })

  it("is left out when the cache is a Valkey sidecar", () => {
    expect(renderSelfHostCompose(project("17.2.13", "valkey"), projectDir())).not.toContain(PASSWORD_ENV)
  })
})

describe("the keyspace password in .env", () => {
  it("is generated on the next dev or up for a project that has none, and kept after", () => {
    const dir = projectDir()
    writeSelfHostCompose(dir, project("17.2.13"))
    const first = readEnvFile(dir)[PASSWORD_ENV]
    expect(first?.length).toBeGreaterThanOrEqual(32)
    writeSelfHostCompose(dir, project("17.2.13"))
    expect(readEnvFile(dir)[PASSWORD_ENV]).toBe(first)
  })

  it("is never rewritten when the project set its own", () => {
    const dir = projectDir(`${PASSWORD_ENV}=chosen-by-me\n`)
    writeSelfHostCompose(dir, project("17.2.13"))
    expect(readEnvFile(dir)[PASSWORD_ENV]).toBe("chosen-by-me")
  })

  it("is not generated for a stack that would not use it", () => {
    const dir = projectDir()
    writeSelfHostCompose(dir, project("17.2.12"))
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain(PASSWORD_ENV)
  })
})

describe("Kong's ACME certificates in a keyspace that requires AUTH", () => {
  const acme = { email: "ops@example.com", domain: "example.com", redisHost: "db" }

  it("logs in as supatype with the password from Kong's environment, never written into kong.yml", () => {
    const kong = buildKongDeclarative({ unifiedGateway: true, acme: { ...acme, redisAuth: true } })
    expect(kong).toContain('username: "supatype"')
    expect(kong).toContain('password: "{vault://env/supatype-keyspace-password}"')
  })

  it("gives Kong the password in its environment when TLS is on", () => {
    const tls: SupatypeProjectConfig = {
      ...project("17.2.13"),
      server: { mode: "standalone", domain: "example.com", tls: { email: "ops@example.com" } },
    }
    expect(serviceBlock(renderSelfHostCompose(tls, projectDir()), "kong")).toContain(REQUIRED)
  })

  it("sends no credentials to a keyspace or Valkey that does not require them", () => {
    expect(buildKongDeclarative({ unifiedGateway: true, acme: { ...acme, redisAuth: false } })).not.toContain("password:")
  })
})

/**
 * 0.9.2 round 2 (R2-S15): a `versions.postgres: "17.2.12"` pin kept the keyspace open on the
 * compose network, as that image takes no password, and nothing said so. Dev and self-host say it.
 */
describe("the notice for a keyspace that cannot require a password", () => {
  it("names the pinned image and the release that closes it", () => {
    const notice = openKeyspaceNotice(project("17.2.12"))
    expect(notice).toMatch(/supatype\/postgres:17\.2\.12 cannot require a keyspace password/)
    expect(notice).toMatch(/open to anything on the compose network/)
    expect(notice).toMatch(/17\.2\.13 or later/)
  })

  it("is said once where dev and self-host check the stack's settings before it starts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      warnMissingStackSettings(projectDir(), project("17.2.12"))
      const open = warn.mock.calls.flat().filter((line) => String(line).includes("cannot require a keyspace password"))
      expect(open).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("is not said for an image that requires one, or for a stack whose cache is Valkey", () => {
    expect(openKeyspaceNotice(project("17.2.13"))).toBeNull()
    expect(openKeyspaceNotice(project("17-latest"))).toBeNull()
    expect(openKeyspaceNotice(project("17.2.12", "valkey"))).toBeNull()
  })
})

/**
 * 0.9.2 round 2 (R2-S16): a project that named its keyspace password in a file, with
 * SUPATYPE_KEYSPACE_PASSWORD_FILE in .env, still got a generated SUPATYPE_KEYSPACE_PASSWORD beside
 * it, and the server, which reads .env, refused to start with both. The file is now mounted into the
 * db and the server, which are told its path in the container, and nothing writes the password.
 */
describe("a keyspace password kept in a file", () => {
  const FILE_ENV = "SUPATYPE_KEYSPACE_PASSWORD_FILE"
  const IN_CONTAINER = "/run/secrets/supatype-keyspace-password"
  const NAMED = `${FILE_ENV}: ${IN_CONTAINER}`
  const MOUNTED = new RegExp(`source: ".*keyspace-password"\\r?\\n +target: ${IN_CONTAINER}\\r?\\n +read_only: true`)

  beforeEach(() => {
    vi.stubEnv(FILE_ENV, undefined)
    vi.stubEnv(PASSWORD_ENV, undefined)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** A project holding `keyspace-password` with `content`, and `env` lines in its .env. */
  function fileProject(env: string, content = "kept-in-a-file\n"): string {
    const dir = projectDir()
    writeFileSync(join(dir, "keyspace-password"), content, "utf8")
    appendFileSync(join(dir, ".env"), env, "utf8")
    return dir
  }

  /** What writeSelfHostCompose printed before it exited, or throws when it did not exit. */
  function refusal(dir: string, config: SupatypeProjectConfig): string {
    const printed: string[] = []
    const capture = (...args: unknown[]): void => {
      printed.push(args.map(String).join(" "))
    }
    vi.spyOn(console, "log").mockImplementation(capture)
    vi.spyOn(console, "error").mockImplementation(capture)
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as typeof process.exit)
    expect(() => writeSelfHostCompose(dir, config)).toThrow("exit 1")
    expect(existsSync(selfHostComposePaths(dir).composePath), "no compose file was written").toBe(false)
    return printed.join("\n")
  }

  it("is mounted read-only into the db and the server, which are given its path instead", () => {
    const dir = fileProject(`${FILE_ENV}=keyspace-password\n`)
    writeSelfHostCompose(dir, project("17.2.13"))
    const compose = readFileSync(selfHostComposePaths(dir).composePath, "utf8")
    for (const service of ["db", "server"]) {
      const block = serviceBlock(compose, service)
      expect(block).toContain(NAMED)
      expect(block).toMatch(MOUNTED)
      expect(block).not.toContain(REQUIRED)
    }
    // The server reads .env and .env.local too, so a password in either is blanked for it.
    expect(serviceBlock(compose, "server")).toContain(`${PASSWORD_ENV}: ""`)
  })

  it("writes no password into .env, whether .env or the shell names the file", () => {
    const fromEnv = fileProject(`${FILE_ENV}=keyspace-password\n`)
    writeSelfHostCompose(fromEnv, project("17.2.13"))
    expect(readEnvFile(fromEnv)[PASSWORD_ENV]).toBeUndefined()

    const fromShell = fileProject("")
    vi.stubEnv(FILE_ENV, join(fromShell, "keyspace-password"))
    writeSelfHostCompose(fromShell, project("17.2.13"))
    expect(readEnvFile(fromShell)[PASSWORD_ENV]).toBeUndefined()
    expect(serviceBlock(readFileSync(selfHostComposePaths(fromShell).composePath, "utf8"), "db")).toMatch(MOUNTED)
  })

  it("refuses .env holding both, naming both, and leaves the password line for the developer to remove", () => {
    const dir = fileProject(`${PASSWORD_ENV}=also-here\n${FILE_ENV}=keyspace-password\n`)
    const out = refusal(dir, project("17.2.13"))
    expect(out).toContain(`${PASSWORD_ENV} and ${FILE_ENV} are both set`)
    expect(out).toContain(`Remove the ${PASSWORD_ENV} line from .env`)
    expect(readEnvFile(dir)[PASSWORD_ENV]).toBe("also-here")
  })

  it("refuses a file that is missing or holds no password, before compose is written", () => {
    expect(refusal(projectDir(`${FILE_ENV}=nowhere\n`), project("17.2.13"))).toMatch(/names .*nowhere, which does not exist/)
    expect(refusal(fileProject(`${FILE_ENV}=keyspace-password\n`, " \n"), project("17.2.13"))).toMatch(
      /names .*keyspace-password, which holds no password/,
    )
  })

  it("refuses HTTPS, whose Kong reads the password from its environment only", () => {
    const tls: SupatypeProjectConfig = {
      ...project("17.2.13"),
      server: { mode: "standalone", domain: "example.com", tls: { email: "ops@example.com" } },
    }
    const out = refusal(fileProject(`${FILE_ENV}=keyspace-password\n`), tls)
    expect(out).toContain(`${FILE_ENV} cannot be used with HTTPS on`)
    expect(out).toContain("env vault")
  })

  it("is what native dev's keyspace is given, with one newline dropped and nothing written to .env", () => {
    const dir = fileProject(`${FILE_ENV}=keyspace-password\n`, "kept-in-a-file\r\n")
    expect(projectKeyspacePassword(dir)).toBe("kept-in-a-file")
    expect(readEnvFile(dir)[PASSWORD_ENV]).toBeUndefined()
    expect(keyspacePasswordOrigin(dir)).toBe(`the file ${FILE_ENV} names`)
    expect(keyspacePasswordOrigin(projectDir())).toBe(`${PASSWORD_ENV} in .env`)
  })
})
