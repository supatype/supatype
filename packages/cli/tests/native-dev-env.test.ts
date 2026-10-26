/**
 * What native `supatype dev` hands its services, decided by which libraries the Postgres install
 * carries.
 *
 * The decisions themselves (`nativeGraphqlServerEnv`, `nativeMaskLibraryPresent`) are pinned
 * elsewhere. These pin the wiring: that the env and script the dev action actually uses reflect
 * them. Before these existed, deleting either line from the dev action left every test green.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  nativeDevRolesSql,
  nativePostgrestSchemaEnv,
  nativeServerCoreEnv,
  type NativeServerCoreInput,
} from "../src/native-dev-env.js"
import {
  postgrestSchemaEnv,
  validateProjectConfig,
  type SupatypeProjectConfig,
} from "../src/project-config.js"

let root: string
let binDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "supatype-native-dev-env-"))
  binDir = join(root, "pg", "bin")
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(root, "pg", "lib"), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Puts a native library into the fake install, the way the Linux archive lays it out. */
function installLibrary(stem: string): void {
  writeFileSync(join(root, "pg", "lib", `${stem}.so`), "")
}

const coreInput = (pgBinDir: string | null): NativeServerCoreInput => ({
  mode: "dev",
  valkeyAddr: "127.0.0.1:6379",
  projectRef: "acme",
  manifestPath: "/p/.supatype/manifest.json",
  adminConfigPath: "/p/.supatype/admin-config.json",
  postgrestPort: "3001",
  pgBinDir,
})

describe("supatype-server's outer environment on the native path", () => {
  it("switches GraphQL off when the install has no pg_graphql", () => {
    expect(nativeServerCoreEnv(coreInput(binDir))["SUPATYPE_GRAPHQL_DISABLED"]).toBe("true")
  })

  it("leaves GraphQL on when the install carries pg_graphql", () => {
    installLibrary("pg_graphql")
    expect(nativeServerCoreEnv(coreInput(binDir))).not.toHaveProperty("SUPATYPE_GRAPHQL_DISABLED")
  })

  it("carries the rest of the outer layer unchanged", () => {
    installLibrary("pg_graphql")
    expect(nativeServerCoreEnv(coreInput(binDir))).toEqual({
      SUPATYPE_MODE: "dev",
      SUPATYPE_VALKEY_ADDR: "127.0.0.1:6379",
      SUPATYPE_MANAGED_PROJECT_REF: "acme",
      SUPATYPE_MANIFEST_PATH: "/p/.supatype/manifest.json",
      SUPATYPE_ADMIN_CONFIG_PATH: "/p/.supatype/admin-config.json",
      SUPATYPE_POSTGREST_URL: "http://127.0.0.1:3001",
    })
  })

  it("omits the cache address when there is none", () => {
    const env = nativeServerCoreEnv({ ...coreInput(binDir), valkeyAddr: "" })
    expect(env).not.toHaveProperty("SUPATYPE_VALKEY_ADDR")
  })
})

const nativeProject = (): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      database: { provider: "native" },
      server: { mode: "dev" },
      app: { mode: "none" },
    },
    "supatype.config.ts",
  )

/** A schema with one masked column, so the tier is decided by whether the mask is installed. */
function writeMaskedSchema(): void {
  mkdirSync(join(root, "schema"))
  writeFileSync(
    join(root, "schema", "index.ts"),
    `import type { Model, Owner, Public, UUID } from "@supatype/types"

export type Employee = Model<{ id: UUID; name: string; salary: number }, {
  access: { read: Public; fields: { salary: { read: Owner<"id"> } } }
}>
`,
    "utf8",
  )
}

describe("PostgREST's schemas on the native path", () => {
  it("serves masked models from the api views when the install has no mask library", () => {
    writeMaskedSchema()
    const env = nativePostgrestSchemaEnv(root, nativeProject(), binDir)
    expect(env).toEqual(postgrestSchemaEnv(nativeProject(), { tier: "views", drafts: false }))
    expect(env.PGRST_DB_EXTRA_SEARCH_PATH).toBe("api,extensions")
  })

  it("serves the base schema when the install carries the mask library", () => {
    writeMaskedSchema()
    installLibrary("supatype_mask")
    const env = nativePostgrestSchemaEnv(root, nativeProject(), binDir)
    expect(env).toEqual(postgrestSchemaEnv(nativeProject(), { tier: "extension", drafts: false }))
    expect(env.PGRST_DB_EXTRA_SEARCH_PATH).toBe("public,extensions")
  })
})

describe("the roles script for a new native database", () => {
  const createsMask = /CREATE EXTENSION IF NOT EXISTS supatype_mask;/

  it("leaves the mask extension out when the install has no library", () => {
    expect(nativeDevRolesSql(binDir)).not.toMatch(createsMask)
  })

  it("creates the mask extension when the install carries the library", () => {
    installLibrary("supatype_mask")
    expect(nativeDevRolesSql(binDir)).toMatch(createsMask)
  })
})
