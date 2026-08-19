import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { isTransientConnectionError, withDatabaseRetry } from "../src/db-retry.js"

/**
 * The line between "not there yet" and "wrong".
 *
 * This classification is the whole design. Too broad and a genuine misconfiguration, bad password,
 * missing database: becomes an infinite wait with no error surfaced. Too narrow and the service
 * exits on a cold start, which is what it used to do, hidden by the Compose `db` healthcheck that a
 * `database.external` stack does not have.
 */
const pgError = (code: string): Error => Object.assign(new Error(`pg said ${code}`), { code })

describe("isTransientConnectionError", () => {
  it("treats socket-level failures as transient", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET"]) {
      expect(isTransientConnectionError(pgError(code)), code).toBe(true)
    }
  })

  it("treats Postgres connection-exception and startup states as transient", () => {
    // 57P03 is "cannot_connect_now": the server is up but still recovering, which is exactly the
    // window a cold start lands in.
    for (const code of ["08006", "08001", "08004", "57P03", "57P01", "53300"]) {
      expect(isTransientConnectionError(pgError(code)), code).toBe(true)
    }
  })

  it("does not retry authentication or naming failures", () => {
    // 28P01 invalid_password, 3D000 invalid_catalog_name, 42501 insufficient_privilege. Retrying
    // any of these forever would bury the one message that says what to fix.
    for (const code of ["28P01", "28000", "3D000", "42501", "42601", "42P01"]) {
      expect(isTransientConnectionError(pgError(code)), code).toBe(false)
    }
  })

  it("recognises the startup message when there is no code", () => {
    expect(
      isTransientConnectionError(new Error('the database system is starting up')),
    ).toBe(true)
    expect(isTransientConnectionError(new Error("relation \"foo\" does not exist"))).toBe(false)
  })

  it("does not treat an arbitrary error as transient", () => {
    expect(isTransientConnectionError(new Error("boom"))).toBe(false)
    expect(isTransientConnectionError(null)).toBe(false)
    expect(isTransientConnectionError("ECONNREFUSED")).toBe(false)
  })
})

describe("withDatabaseRetry", () => {
  const collect = () => {
    const lines: string[] = []
    return { lines, log: (m: string) => lines.push(m) }
  }
  const noSleep = async () => {}

  it("returns the first success without logging", async () => {
    const { lines, log } = collect()
    await expect(withDatabaseRetry(async () => "ok", { label: "t", log, sleep: noSleep })).resolves.toBe(
      "ok",
    )
    expect(lines).toEqual([])
  })

  it("keeps retrying a transient failure until it succeeds", async () => {
    const { lines, log } = collect()
    let attempts = 0
    const result = await withDatabaseRetry(
      async () => {
        attempts++
        if (attempts < 4) throw pgError("ECONNREFUSED")
        return "connected"
      },
      { label: "realtime replication", log, sleep: noSleep },
    )
    expect(result).toBe("connected")
    expect(attempts).toBe(4)
    // Every wait is reported, with elapsed time, so a database down for ten minutes reads as that
    // rather than as a service that quietly stopped trying.
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("realtime replication")
    expect(lines[0]).toContain("attempt 1")
    expect(lines[2]).toContain("attempt 3")
  })

  it("rethrows a non-transient failure on the first attempt", async () => {
    const { lines, log } = collect()
    let attempts = 0
    await expect(
      withDatabaseRetry(
        async () => {
          attempts++
          throw pgError("28P01")
        },
        { label: "t", log, sleep: noSleep },
      ),
    ).rejects.toThrow("28P01")
    expect(attempts).toBe(1)
    expect(lines).toEqual([])
  })

  it("stops when shouldContinue goes false, rather than looping against a shutdown", async () => {
    const { log } = collect()
    let attempts = 0
    let live = true
    await expect(
      withDatabaseRetry(
        async () => {
          attempts++
          if (attempts === 2) live = false
          throw pgError("ECONNREFUSED")
        },
        { label: "t", log, sleep: noSleep, shouldContinue: () => live },
      ),
    ).rejects.toThrow("ECONNREFUSED")
    expect(attempts).toBe(2)
  })

  it("backs off, capped", async () => {
    const delays: number[] = []
    let attempts = 0
    await withDatabaseRetry(
      async () => {
        attempts++
        if (attempts < 8) throw pgError("ECONNREFUSED")
        return null
      },
      {
        label: "t",
        log: () => {},
        sleep: async (ms) => {
          delays.push(ms)
        },
      },
    )
    expect(delays[0]).toBe(500)
    expect(delays[1]).toBe(1000)
    // Capped, so a long outage retries every ten seconds rather than once an hour.
    expect(Math.max(...delays)).toBe(10_000)
  })
})

describe("the storage copy", () => {
  it("has not drifted from this one", () => {
    // Two services, two containers, no shared server-side package to put this in, so the file is
    // duplicated, and the error classification is precisely the part that must not diverge. Only the
    // leading doc comment differs, since each explains its own service's failure.
    const here = dirname(fileURLToPath(import.meta.url))
    const body = (path: string) => {
      const text = readFileSync(path, "utf8")
      return text.slice(text.indexOf("/** Postgres and libpq error codes"))
    }
    expect(body(resolve(here, "../src/db-retry.ts"))).toBe(
      body(resolve(here, "../../storage/src/db-retry.ts")),
    )
  })
})
