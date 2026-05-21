import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { pgSpawnEnv } from "../src/postgres-ctl.js"

const PG_BIN = "/cache/postgres/17.2/pg-17.2/bin"
const PG_LIB = join("/cache/postgres/17.2/pg-17.2", "lib")

describe("pgSpawnEnv", () => {
  it("prepends lib dir to DYLD_LIBRARY_PATH on darwin", () => {
    const env = pgSpawnEnv(PG_BIN, "darwin")
    expect(env.DYLD_LIBRARY_PATH).toContain(PG_LIB)
  })

  it("prepends lib dir to LD_LIBRARY_PATH on linux", () => {
    const env = pgSpawnEnv(PG_BIN, "linux")
    expect(env.LD_LIBRARY_PATH).toContain(PG_LIB)
  })
})
