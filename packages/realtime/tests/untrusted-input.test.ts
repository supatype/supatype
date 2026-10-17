import { describe, expect, it } from "vitest"
import jwt from "jsonwebtoken"
import { parseClientMessage } from "../src/client-message.js"
import { verifyToken } from "../src/auth.js"
import { parseSchemaFilterMode } from "../src/env.js"
import { parseWal2json } from "../src/replication.js"

/**
 * What arrives from outside the process is checked before a handler reads it: a client's frame, a
 * token's claims, an environment setting, wal2json's output.
 */

describe("parseClientMessage", () => {
  it("reads each message a client sends", () => {
    expect(parseClientMessage(JSON.stringify({ type: "subscribe", channel: "room", event: "*", filter: { id: "eq.1" } })))
      .toEqual({ type: "subscribe", channel: "room", event: "*", filter: { id: "eq.1" } })
    expect(parseClientMessage(JSON.stringify({ type: "auth", token: "t" }))).toEqual({ type: "auth", token: "t" })
    expect(parseClientMessage(JSON.stringify({ type: "broadcast", channel: "c", event: "e", payload: {} })))
      .toEqual({ type: "broadcast", channel: "c", event: "e", payload: {} })
  })

  it.each([
    ["not JSON", "{"],
    ["an unknown type", JSON.stringify({ type: "shout", channel: "c" })],
    ["a subscribe with no channel", JSON.stringify({ type: "subscribe" })],
    ["an event no change has", JSON.stringify({ type: "subscribe", channel: "c", event: "insert" })],
    ["a filter value that is not a string", JSON.stringify({ type: "subscribe", channel: "c", filter: { id: 1 } })],
    ["a broadcast payload that is not an object", JSON.stringify({ type: "broadcast", channel: "c", event: "e", payload: "x" })],
    ["an auth with no token", JSON.stringify({ type: "auth" })],
  ])("refuses %s", (_label, frame) => {
    expect(parseClientMessage(frame)).toBeNull()
  })
})

describe("verifyToken", () => {
  const secret = "test-secret-test-secret-test-secret"

  it("reads a key that names no user, as the anon and service-role keys do", () => {
    expect(verifyToken(jwt.sign({ role: "anon" }, secret), secret)).toMatchObject({ role: "anon" })
  })

  it("refuses a token whose role is not a string", () => {
    expect(verifyToken(jwt.sign({ sub: "u", role: ["service_role"] }, secret), secret)).toBeNull()
  })
})

describe("parseSchemaFilterMode", () => {
  it("defaults to developer_only and reads both modes", () => {
    expect(parseSchemaFilterMode(undefined)).toBe("developer_only")
    expect(parseSchemaFilterMode("all")).toBe("all")
    expect(parseSchemaFilterMode("developer_only")).toBe("developer_only")
  })

  it("refuses anything else", () => {
    expect(() => parseSchemaFilterMode("everything")).toThrow(/SCHEMA_FILTER_MODE/)
  })
})

describe("parseWal2json", () => {
  it("keeps the row changes of a transaction and drops an entry that names no table", () => {
    const changes = parseWal2json(
      JSON.stringify({
        change: [
          { kind: "message", transactional: true, prefix: "p", content: "c" },
          { kind: "insert", schema: "public", table: "posts", columnnames: ["id"], columntypes: ["integer"], columnvalues: [1] },
        ],
      }),
    )
    expect(changes.map((c) => `${c.schema}.${c.table}`)).toEqual(["public.posts"])
  })
})
