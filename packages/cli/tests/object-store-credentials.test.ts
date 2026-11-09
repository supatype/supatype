import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isArrayOf, isShape, isString } from "@supatype/shared"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { readEnvFile } from "../src/env-file.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { writeSelfHostCompose } from "../src/self-host-compose.js"
import { parseJsonAs } from "./support/json.js"

/**
 * Issue 71: every self-host stack shared one object-store login, `supatype` / `supatype-secret`,
 * which reads and writes every file past the bucket rules. Each project now has its own pair, in
 * `.env`, and the object store and the storage service both take it from there.
 */

const ACCESS_ENV = "SUPATYPE_OBJECT_STORE_ACCESS_KEY"
const SECRET_ENV = "SUPATYPE_OBJECT_STORE_SECRET_KEY"

const config: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
}

const isS3Config = isShape({
  identities: isArrayOf(
    isShape({
      name: isString,
      credentials: isArrayOf(isShape({ accessKey: isString, secretKey: isString })),
    }),
  ),
})

/** The one credential the rendered `s3.json` accepts. */
function identityIn(path: string): { accessKey: string; secretKey: string } {
  const parsed = parseJsonAs(readFileSync(path, "utf8"), isS3Config)
  const credential = parsed.identities[0]?.credentials[0]
  if (credential === undefined) throw new Error("s3.json has no credential")
  return credential
}

/** The lines of one compose service, up to the next service. */
function serviceBlock(compose: string, name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`)
  if (start < 0) throw new Error(`no ${name} service`)
  const rest = compose.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

describe("object store credentials (issue 71)", () => {
  let dirs: string[] = []
  const project = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-objstore-"))
    dirs.push(dir)
    return dir
  }
  beforeEach(() => {
    dirs = []
  })
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it("init writes a generated pair, different in each project", () => {
    const a = project()
    const b = project()
    scaffold(a, defaultScaffoldOptions("alpha"))
    scaffold(b, defaultScaffoldOptions("beta"))
    const envA = readEnvFile(a)
    const envB = readEnvFile(b)
    expect(envA[ACCESS_ENV]?.length).toBeGreaterThanOrEqual(16)
    expect(envA[SECRET_ENV]?.length).toBeGreaterThanOrEqual(32)
    expect(envA[ACCESS_ENV]).not.toBe(envB[ACCESS_ENV])
    expect(envA[SECRET_ENV]).not.toBe(envB[SECRET_ENV])
    expect(readFileSync(join(a, ".env"), "utf8")).not.toContain("supatype-secret")
  })

  it("the object store and the storage service both take the project's pair from .env", () => {
    const dir = project()
    writeFileSync(join(dir, ".env"), `JWT_SECRET=${"j".repeat(64)}\n`, "utf8")
    const out = writeSelfHostCompose(dir, config)
    const env = readEnvFile(dir)
    const compose = readFileSync(out.composePath, "utf8")

    expect(identityIn(out.s3ConfigPath)).toEqual({ accessKey: env[ACCESS_ENV], secretKey: env[SECRET_ENV] })
    const storage = serviceBlock(compose, "storage")
    expect(storage).toContain(`S3_ACCESS_KEY: \${${ACCESS_ENV}:?`)
    expect(storage).toContain(`S3_SECRET_KEY: \${${SECRET_ENV}:?`)
    expect(compose).not.toContain("supatype-secret")
    // The object store loads s3.json only when it starts, so its service has to change with the
    // pair, or compose would leave it running with the old one while storage got the new one.
    const seaweed = serviceBlock(compose, "seaweedfs")
    expect(seaweed).toContain(`\${${ACCESS_ENV}:?`)
    expect(seaweed).toContain(`\${${SECRET_ENV}:?`)
  })

  it("gives two projects different pairs, and keeps a project's pair from one run to the next", () => {
    const a = project()
    const b = project()
    const pathsA = writeSelfHostCompose(a, config)
    const first = identityIn(pathsA.s3ConfigPath)
    writeSelfHostCompose(b, config)
    expect(identityIn(join(b, ".supatype", "self-host", "s3.json"))).not.toEqual(first)

    writeSelfHostCompose(a, config)
    expect(identityIn(pathsA.s3ConfigPath)).toEqual(first)
  })

  it("replaces the old shared pair in a project init made before the fix", () => {
    const dir = project()
    writeFileSync(
      join(dir, ".env"),
      [
        "# Storage (local development, SeaweedFS)",
        "S3_ENDPOINT=http://localhost:8333",
        "S3_ACCESS_KEY=supatype",
        "S3_SECRET_KEY=supatype-secret",
        "",
      ].join("\n"),
      "utf8",
    )
    const out = writeSelfHostCompose(dir, config)
    const text = readFileSync(join(dir, ".env"), "utf8")
    const credential = identityIn(out.s3ConfigPath)

    expect(text).not.toContain("supatype-secret")
    expect(text).not.toMatch(/^S3_ACCESS_KEY=supatype$/m)
    expect(credential.accessKey).not.toBe("supatype")
    expect(credential.secretKey).not.toBe("supatype-secret")
  })

  it("leaves an external bucket's own S3_ keys alone", () => {
    const dir = project()
    writeFileSync(join(dir, ".env"), "S3_ACCESS_KEY=AKIAEXAMPLE\nS3_SECRET_KEY=abc123\n", "utf8")
    writeSelfHostCompose(dir, config)
    const env = readEnvFile(dir)
    expect(env["S3_ACCESS_KEY"]).toBe("AKIAEXAMPLE")
    expect(env["S3_SECRET_KEY"]).toBe("abc123")
    expect(env[ACCESS_ENV]).not.toBe("AKIAEXAMPLE")
  })
})
