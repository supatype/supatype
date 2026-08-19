import { describe, it, expect } from "vitest"
import { unsupportedRealtimeReason } from "../src/capability.js"

/**
 * "This database will never support realtime" is a third state, distinct from transient and fatal.
 *
 * Retrying does not help and exiting is wrong: the rest of the stack is fine, and the operator's
 * database may simply not offer logical decoding. Cloud SQL ships no `wal2json`; plenty of managed
 * Postgres will not grant `REPLICATION`.
 *
 * The SQLSTATEs are measured against `supatype/postgres`, not recalled, see capability.ts.
 */
const pgError = (code: string, message = "") => Object.assign(new Error(message || code), { code })

describe("unsupportedRealtimeReason", () => {
  it("names wal_level", () => {
    expect(unsupportedRealtimeReason(pgError("55000", 'logical decoding requires "wal_level" >= "logical"'))).toBe(
      "wal_level is not logical",
    )
  })

  it("names the missing output plugin", () => {
    expect(
      unsupportedRealtimeReason(pgError("58P01", 'could not access file "wal2json": No such file or directory')),
    ).toBe("the wal2json output plugin is not installed")
  })

  it("names the replication privilege", () => {
    expect(unsupportedRealtimeReason(pgError("42501", "permission denied to use replication slots"))).toBe(
      "the database role may not use replication slots",
    )
  })

  it("recognises each condition from the message alone", () => {
    // Poolers and proxies flatten errors to a string, dropping the code.
    expect(unsupportedRealtimeReason(new Error('logical decoding requires "wal_level" >= "logical"'))).toBe(
      "wal_level is not logical",
    )
    expect(unsupportedRealtimeReason(new Error('could not access file "wal2json": No such file'))).toBe(
      "the wal2json output plugin is not installed",
    )
    expect(unsupportedRealtimeReason(new Error("permission denied to use replication slots"))).toBe(
      "the database role may not use replication slots",
    )
  })

  it("is undefined for anything else", () => {
    // The point of the narrow list: a connection refusal is transient and must keep retrying, and a
    // missing table is a bug that must not be reported as "realtime unsupported".
    expect(unsupportedRealtimeReason(pgError("ECONNREFUSED"))).toBeUndefined()
    expect(unsupportedRealtimeReason(pgError("42P01", 'relation "x" does not exist'))).toBeUndefined()
    expect(unsupportedRealtimeReason(pgError("28P01", "password authentication failed"))).toBeUndefined()
    expect(unsupportedRealtimeReason(new Error("boom"))).toBeUndefined()
    expect(unsupportedRealtimeReason(null)).toBeUndefined()
  })
})
