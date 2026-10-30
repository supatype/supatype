import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as ctl from "../src/postgres-ctl.js"
import * as auth from "../src/native-pg-auth.js"
import * as secrets from "../src/local-secrets.js"
import { nativeRolesSql } from "../src/native-roles-sql.js"
import { localDSN, STACK_API_SCHEMAS } from "../src/project-config.js"
import { projectConfig } from "./support/project-config.js"

// Native `supatype dev` initialised its cluster with `--auth trust`: the passwords the CLI
// generates were never checked, so any local process could connect as any role, the superuser
// included, with any password or none. A live run on the base showed `psql -U postgres` with a
// wrong password connecting. These pin the pieces that make the passwords count.

describe("initdb", () => {
  it("asks for scram-sha-256 on local and host connections, with the superuser's password", () => {
    const args = ctl.initdbArgs("/data", "/tmp/pw", { major: 17, icu: true })
    expect(args).toContain("--auth-local=scram-sha-256")
    expect(args).toContain("--auth-host=scram-sha-256")
    expect(args).toContain("--pwfile=/tmp/pw")
    expect(args.join(" ")).not.toMatch(/trust/)
  })
})

describe("a data directory initialised with trust", () => {
  const trustHba = [
    "# TYPE  DATABASE        USER            ADDRESS                 METHOD",
    "# \"trust\" lets anyone in; see the docs",
    "local   all             all                                     trust",
    "host    all             all             127.0.0.1/32            trust",
    "host    all             all             ::1/128                 trust",
    "local   replication     all                                     trust",
    "",
  ].join("\n")

  it("has every trust entry rewritten to scram-sha-256, and the comments left alone", () => {
    const out = auth.hbaWithoutTrust(trustHba)
    expect(out).not.toBeNull()
    const active = (out ?? "").split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"))
    expect(active).toHaveLength(4)
    for (const line of active) expect(line).toMatch(/\sscram-sha-256$/)
    expect(out).toContain("# \"trust\" lets anyone in; see the docs")
  })

  it("is left alone when nothing grants trust", () => {
    expect(auth.hbaWithoutTrust(auth.hbaWithoutTrust(trustHba) ?? "")).toBeNull()
  })

  it("is recognised from its pg_hba.conf", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-hba-"))
    writeFileSync(join(dir, "pg_hba.conf"), trustHba)
    expect(auth.clusterGrantsTrust(dir)).toBe(true)
    writeFileSync(join(dir, "pg_hba.conf"), auth.hbaWithoutTrust(trustHba) ?? "")
    expect(auth.clusterGrantsTrust(dir)).toBe(false)
  })
})

describe("the superuser's password", () => {
  it("is generated and stored in .env when the project has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-native-pw-"))
    const pw = secrets.ensureNativeSuperuserPassword(dir)
    expect(pw).not.toBe(secrets.FALLBACK_POSTGRES_PASSWORD)
    expect(pw.length).toBeGreaterThanOrEqual(24)
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(`POSTGRES_PASSWORD=${pw}`)
    expect(secrets.ensureNativeSuperuserPassword(dir)).toBe(pw)
  })

  it("comes with a generated authenticator password too, the role PostgREST connects as", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-native-pw-"))
    const pw = secrets.ensureNativeAuthenticatorPassword(dir)
    expect(pw).not.toBe(secrets.FALLBACK_AUTHENTICATOR_PASSWORD)
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(`AUTHENTICATOR_PASSWORD=${pw}`)
  })

  it("is the project's own when .env has one", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-native-pw-"))
    writeFileSync(join(dir, ".env"), "POSTGRES_PASSWORD=mine-0123456789\n")
    expect(secrets.ensureNativeSuperuserPassword(dir)).toBe("mine-0123456789")
  })

  it("is what the default local connection string carries", () => {
    const cfg = projectConfig()
    expect(localDSN(cfg, "s3cret")).toBe("postgres://postgres:s3cret@127.0.0.1:5432/demo?sslmode=disable")
  })
})

describe("authenticator", () => {
  it("is given .env's password on every start, not only when the role is created", () => {
    // A cluster that predates password checks has the role already, under whatever password it
    // had; with trust gone, PostgREST connects with .env's and must get in.
    expect(nativeRolesSql(false)).toMatch(/ALTER ROLE authenticator[^;]*PASSWORD %L/)
  })
})

describe("the schemas PostgREST is told to serve", () => {
  // PostgREST answers 503 on every request when a schema in its list does not exist. The
  // supatype/postgres image creates `graphql_public`; a native Postgres has no pg_graphql and
  // nothing created the schema, so `/rest/v1/` was down on every native project. `supatype` is
  // the engine's, created by the first push, which runs before PostgREST starts.
  const createdByEngine = new Set(["supatype"])

  for (const schema of STACK_API_SCHEMAS.filter((s) => !createdByEngine.has(s))) {
    it(`includes ${schema}, which the native bootstrap creates`, () => {
      for (const withMask of [false, true]) {
        expect(nativeRolesSql(withMask)).toContain(`CREATE SCHEMA IF NOT EXISTS ${schema};`)
      }
    })
  }

  it("lets the API roles use graphql_public, as the image's pg_graphql migration does", () => {
    expect(nativeRolesSql(false)).toContain(
      "GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;",
    )
  })
})

describe("a data directory whose superuser password is gone from .env", () => {
  // With POSTGRES_PASSWORD deleted, the CLI generated a new one, wrote it to .env, and the next
  // start failed on a bare "password authentication failed": the cluster still has the old one.
  function cluster(hba: string): string {
    const dataDir = mkdtempSync(join(tmpdir(), "supatype-native-data-"))
    writeFileSync(join(dataDir, "PG_VERSION"), "17\n")
    writeFileSync(join(dataDir, "pg_hba.conf"), hba)
    return dataDir
  }
  const scramHba = "host    all             all             127.0.0.1/32            scram-sha-256\n"
  const trustHba = "host    all             all             127.0.0.1/32            trust\n"

  it("is recognised when the cluster checks passwords and .env has none", () => {
    const project = mkdtempSync(join(tmpdir(), "supatype-native-pw-"))
    expect(auth.superuserPasswordMissing(project, cluster(scramHba))).toBe(true)
  })

  it("is not a problem when .env has the password", () => {
    const project = mkdtempSync(join(tmpdir(), "supatype-native-pw-"))
    writeFileSync(join(project, ".env"), "POSTGRES_PASSWORD=mine-0123456789\n")
    expect(auth.superuserPasswordMissing(project, cluster(scramHba))).toBe(false)
  })

  it("is not a problem for a cluster that still trusts, which is given the new password", () => {
    const project = mkdtempSync(join(tmpdir(), "supatype-native-pw-"))
    expect(auth.superuserPasswordMissing(project, cluster(trustHba))).toBe(false)
  })

  it("is not a problem before initdb, or after `supatype pg reset` empties the directory", () => {
    const project = mkdtempSync(join(tmpdir(), "supatype-native-pw-"))
    expect(auth.superuserPasswordMissing(project, mkdtempSync(join(tmpdir(), "supatype-empty-")))).toBe(false)
    expect(auth.superuserPasswordMissing(project, join(project, "no-such-dir"))).toBe(false)
  })

  it("is explained with both ways out, and the data directory", () => {
    const message = auth.superuserPasswordMissingMessage("/data/demo")
    expect(message.title).toMatch(/POSTGRES_PASSWORD/)
    expect(message.title).toContain("/data/demo")
    expect(message.hints.join("\n")).toMatch(/restore POSTGRES_PASSWORD/i)
    expect(message.hints.join("\n")).toContain("supatype pg reset")
  })
})
