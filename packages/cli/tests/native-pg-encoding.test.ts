import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createdbArgs, hasIcuLibraries, icuFromConfigure, initdbArgs, nonUtf8DatabaseWarning } from "../src/postgres-ctl.js"

/**
 * Local test round 3 N10: native dev on Windows created WIN1252 databases, because initdb and
 * createdb were given no encoding and took the Windows code page, so Cyrillic, Greek, CJK and
 * emoji were refused. Native clusters and databases are UTF8 on every platform, and sort by
 * language through ICU's en-US, as the image's en_US.utf8 does.
 */
const ICU_17 = { major: 17, icu: true }

describe("native Postgres encoding and collation", () => {
  it("initialises UTF8 with ICU's en-US collation when the build has ICU", () => {
    const args = initdbArgs("/data", "/tmp/pw", ICU_17)
    expect(args).toEqual(expect.arrayContaining(["--encoding=UTF8", "--locale=C", "--locale-provider=icu", "--icu-locale=en-US"]))
  })

  it("falls back to the builtin C.UTF-8 on a Postgres 17 without ICU, and to C before 17", () => {
    const builtin = initdbArgs("/data", "/tmp/pw", { major: 17, icu: false })
    expect(builtin).toEqual(expect.arrayContaining(["--encoding=UTF8", "--locale-provider=builtin", "--builtin-locale=C.UTF-8"]))
    const plain = initdbArgs("/data", "/tmp/pw", { major: 16, icu: false })
    expect(plain).toEqual(expect.arrayContaining(["--encoding=UTF8", "--locale=C"]))
    expect(plain.join(" ")).not.toMatch(/icu|builtin/)
  })

  it("creates the project database the same way, from template0, whatever template1 holds", () => {
    const args = createdbArgs(["-h", "127.0.0.1"], "demo", ICU_17)
    expect(args).toEqual(expect.arrayContaining(["--encoding=UTF8", "--template=template0", "--locale-provider=icu", "--icu-locale=en-US"]))
    expect(args.at(-1)).toBe("demo")
  })

  // Review of round 3b: `--locale-provider` came with Postgres 15 and `builtin` with 17, so an older
  // initdb refused the flags outright.
  it("names a locale provider only where the Postgres has it", () => {
    const icu14 = initdbArgs("/data", "/tmp/pw", { major: 14, icu: true })
    expect(icu14).toEqual(expect.arrayContaining(["--encoding=UTF8", "--locale=C"]))
    expect(icu14.join(" ")).not.toMatch(/locale-provider/)
    expect(initdbArgs("/data", "/tmp/pw", { major: 15, icu: true })).toContain("--locale-provider=icu")
    expect(initdbArgs("/data", "/tmp/pw", { major: null, icu: true }).join(" ")).not.toMatch(/locale-provider/)
  })

  it("finds ICU by its libraries when pg_config says nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-pg-icu-"))
    try {
      mkdirSync(join(dir, "bin"))
      mkdirSync(join(dir, "lib"))
      expect(hasIcuLibraries(join(dir, "bin"))).toBe(false)
      writeFileSync(join(dir, "lib", "libicuuc.so.74"), "")
      expect(hasIcuLibraries(join(dir, "bin"))).toBe(true)
      rmSync(join(dir, "lib", "libicuuc.so.74"))
      writeFileSync(join(dir, "bin", "libicuuc78.dll"), "")
      expect(hasIcuLibraries(join(dir, "bin"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reads ICU support from pg_config --configure", () => {
    expect(icuFromConfigure(" '--prefix=/x' '--with-openssl' '--with-icu'", 17)).toBe(true)
    expect(icuFromConfigure(" '--prefix=/x' '--without-icu'", 17)).toBe(false)
    // ICU is on by default from Postgres 16, and off by default before it.
    expect(icuFromConfigure(" '--prefix=/x'", 16)).toBe(true)
    expect(icuFromConfigure(" '--prefix=/x'", 15)).toBe(false)
    expect(icuFromConfigure("", null)).toBe(false)
  })

  it("warns about a database an older CLI created in another encoding, and says how to start fresh", () => {
    const warning = nonUtf8DatabaseWarning("WIN1252", "demo", "C:\\data") ?? ""
    expect(warning).toMatch(/"demo" is WIN1252, not UTF8/)
    expect(warning).toContain("C:\\data")
    expect(nonUtf8DatabaseWarning("UTF8", "demo", "C:\\data")).toBeNull()
    expect(nonUtf8DatabaseWarning(null, "demo", "C:\\data")).toBeNull()
  })
})
