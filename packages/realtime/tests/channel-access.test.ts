import { describe, expect, it } from "vitest"
import { decideJoin, tightest, type AccessRow, type ChannelMode } from "../src/channel-access.js"
import { parseSendChecks, sendChecksAdmit } from "../src/send-checks.js"
import { parseChannelsMode } from "../src/env.js"

/**
 * The decision table of plan 4.1 and the content checks of 13.2, without a socket or a database.
 * The server tests prove the wiring; these prove the answers, including the ones the database's
 * functions are unlikely to give but a broken one could.
 */

const NOW = 1_000

const row = (over: Partial<AccessRow> = {}): AccessRow => ({
  channel: "LotChannel",
  pattern: "lot:{id}",
  param_error: null,
  fits: true,
  can_join: true,
  can_send: true,
  can_track: true,
  ...over,
})

const decide = (r: AccessRow | null, mode: ChannelMode, isPrivate = false) =>
  decideJoin("lot:1", r, { mode, isPrivate, now: NOW })

describe("a join, by the database's answer and the project's mode", () => {
  it.each(["open", "declared"] as const)("is admitted on a row that fits and may join, in %s mode", (mode) => {
    expect(decide(row(), mode)).toMatchObject({ admitted: true, grant: { declaration: "LotChannel", send: null, track: null } })
  })

  it.each(["open", "declared"] as const)("is refused on a row that fits and may not join, in %s mode", (mode) => {
    expect(decide(row({ can_join: false }), mode)).toMatchObject({ admitted: false })
  })

  it("is refused when the topic does not fit, even if a broken rule said it could join", () => {
    // Without this a topic one typo from a private channel would be an undeclared, open one.
    expect(decide(row({ fits: false, can_join: true }), "open")).toEqual({
      admitted: false,
      code: "does_not_fit",
      message: "lot:1 does not fit lot:{id}",
    })
  })

  it("names the parameter that does not fit", () => {
    expect(decide(row({ fits: false, can_join: false, param_error: "id must be a UUID" }), "open")).toEqual({
      admitted: false,
      code: "does_not_fit",
      message: "lot:1 does not fit lot:{id}: id must be a UUID",
    })
  })

  it("reads a NULL verdict as no rule, so only the service role may: never a grant", () => {
    expect(decide(row({ can_join: null }), "open")).toEqual({
      admitted: false,
      code: "join_denied",
      message: "LotChannel declares no join rule, so only the service role may join lot:1",
    })
    expect(decide(row({ can_send: null, can_track: null }), "open")).toMatchObject({
      admitted: true,
      grant: {
        send: { code: "send_denied", message: "LotChannel declares no send rule, so only the service role may broadcast on lot:1" },
        track: { code: "track_denied", message: "LotChannel declares no track rule, so only the service role may track presence on lot:1" },
      },
    })
  })

  it("tells a rule that said no from a declaration with no rule", () => {
    expect(decide(row({ can_send: false }), "open")).toMatchObject({
      grant: { send: { code: "send_denied", message: "not allowed to broadcast on lot:1: the send rule of LotChannel denied it" } },
    })
  })

  it("is refused with no row when it was opened as private, in either mode", () => {
    for (const mode of ["open", "declared"] as const) {
      expect(decide(null, mode, true)).toEqual({
        admitted: false,
        code: "not_declared",
        message: "lot:1 was opened as private, but no Channel declaration matches it",
      })
    }
  })

  it("is admitted with no row, and in declared mode only listens", () => {
    expect(decide(null, "open")).toMatchObject({ admitted: true, grant: { send: null, track: null } })
    const declared = decide(null, "declared")
    expect(declared).toMatchObject({
      admitted: true,
      grant: { send: { code: "send_denied" }, track: { code: "track_denied" } },
    })
    expect(JSON.stringify(declared)).toMatch(/matches no declared channel.*matches no declared channel/)
  })

  it("remembers that it was opened as private, so a removed declaration takes the channel away", () => {
    expect(decide(row(), "open", true)).toMatchObject({ grant: { openedAsPrivate: true } })
    expect(decide(row(), "open", false)).toMatchObject({ grant: { openedAsPrivate: false } })
  })
})

describe("the mode in force", () => {
  it("is declared when either the database or the environment says so, and never loosened", () => {
    expect(tightest("open", undefined)).toBe("open")
    expect(tightest("declared", "open")).toBe("declared")
    expect(tightest("open", "declared")).toBe("declared")
    expect(tightest("declared", undefined)).toBe("declared")
  })
})

describe("the content checks of a send rule", () => {
  const rule = (raw: unknown) => parseSendChecks(raw)

  it("admit anything when the channel has none", () => {
    expect(sendChecksAdmit(rule(null), "x", {})).toBe(true)
  })

  it("require the named event", () => {
    const checks = rule({ type: "event", name: "bid" })
    expect(sendChecksAdmit(checks, "bid", {})).toBe(true)
    expect(sendChecksAdmit(checks, "bidx", {})).toBe(false)
  })

  it("check type, presence, length and range of a payload field, and treat a missing field as a failure", () => {
    const number = rule({ type: "payload", field: "amount", check: { kind: "number", min: 1, max: 10 } })
    expect(sendChecksAdmit(number, "e", { amount: 1 })).toBe(true)
    expect(sendChecksAdmit(number, "e", { amount: 0 })).toBe(false)
    expect(sendChecksAdmit(number, "e", { amount: 11 })).toBe(false)
    expect(sendChecksAdmit(number, "e", { amount: "5" })).toBe(false)
    expect(sendChecksAdmit(number, "e", {})).toBe(false)
    const text = rule({ type: "payload", field: "text", check: { kind: "string", maxLength: 3 } })
    expect(sendChecksAdmit(text, "e", { text: "abc" })).toBe(true)
    expect(sendChecksAdmit(text, "e", { text: "abcd" })).toBe(false)
    expect(sendChecksAdmit(rule({ type: "payload", field: "ok", check: { kind: "boolean" } }), "e", { ok: false })).toBe(true)
    const required = rule({ type: "payload", field: "x", check: { kind: "required" } })
    expect(sendChecksAdmit(required, "e", { x: null })).toBe(false)
    expect(sendChecksAdmit(required, "e", { x: 0 })).toBe(true)
  })

  it("do not read an inherited property as a payload field", () => {
    const required = rule({ type: "payload", field: "constructor", check: { kind: "required" } })
    expect(sendChecksAdmit(required, "e", {})).toBe(false)
  })

  it("combine with all and any, and read a bare array as all", () => {
    const either = rule({ type: "any", rules: [{ type: "event", name: "a" }, { type: "event", name: "b" }] })
    expect(sendChecksAdmit(either, "b", {})).toBe(true)
    expect(sendChecksAdmit(either, "c", {})).toBe(false)
    const both = rule([{ type: "event", name: "a" }, { type: "payload", field: "n", check: { kind: "required" } }])
    expect(sendChecksAdmit(both, "a", { n: 1 })).toBe(true)
    expect(sendChecksAdmit(both, "a", {})).toBe(false)
  })

  it("refuse everything when the rule is one the server cannot read, rather than admit it", () => {
    expect(sendChecksAdmit(rule({ type: "unheard-of" }), "e", {})).toBe(false)
    expect(sendChecksAdmit(rule([{ type: "event", name: "a" }, { nope: true }]), "a", {})).toBe(false)
    expect(sendChecksAdmit(rule({ type: "payload", field: "n", check: { kind: "regex" } }), "e", { n: 1 })).toBe(false)
  })
})

describe("REALTIME_CHANNELS", () => {
  it("is no opinion when unset or blank, and reads either mode in any case", () => {
    expect(parseChannelsMode(undefined)).toBeUndefined()
    expect(parseChannelsMode("  ")).toBeUndefined()
    expect(parseChannelsMode("Declared")).toBe("declared")
    expect(parseChannelsMode("open")).toBe("open")
  })

  it("stops the service on anything else, rather than quietly meaning open", () => {
    expect(() => parseChannelsMode("strict")).toThrow('REALTIME_CHANNELS must be "open" or "declared"')
  })
})
