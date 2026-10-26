/**
 * Native dev tells supatype-server when its Postgres has no pg_graphql.
 *
 * No native archive carries pg_graphql (it is a pgrx extension, built only into the
 * supatype/postgres image), so `/graphql/v1` on native dev reached PostgREST and answered
 * "could not find the function graphql_public.graphql", which reads like a fault in the caller's
 * query. The server answers 501 `graphql_unavailable` when SUPATYPE_GRAPHQL_DISABLED is set; this is
 * the CLI's half: set it exactly when the install has no library, and not otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { nativeGraphqlServerEnv } from "../src/postgres-ctl.js"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "supatype-native-gql-"))
  mkdirSync(join(root, "bin"))
  mkdirSync(join(root, "lib", "postgresql"), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("the GraphQL setting native dev hands supatype-server", () => {
  it("switches GraphQL off when the install has no pg_graphql", () => {
    expect(nativeGraphqlServerEnv(join(root, "bin"))).toEqual({ SUPATYPE_GRAPHQL_DISABLED: "true" })
  })

  for (const lib of ["lib/postgresql/pg_graphql.dll", "lib/pg_graphql.so", "lib/pg_graphql.dylib"]) {
    it(`leaves GraphQL on when the install carries ${lib}`, () => {
      writeFileSync(join(root, ...lib.split("/")), "")
      expect(nativeGraphqlServerEnv(join(root, "bin"))).toEqual({})
    })
  }
})
