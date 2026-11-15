import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { errorMessage } from "../src/error-message.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

/**
 * `Channel<>` declarations: what they extract to (the build contract, section 14.1 of
 * Realtime-Private-Channels-Plan.md) and every way one is refused at extract time.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const HEADER = [
  `import type { Model, UUID, Int, Channel, Param, Event, Payload, LoggedIn, Public, In, Exists, Rows,`,
  `  Eq, All, Any, Not, Role, AuthUid, Claim } from "@supatype/types"`,
  `export type Lot = Model<{ id: UUID }, { access: { read: LoggedIn } }>`,
  `type MyLots = Rows<"lot_watchers", "lot_id", Eq<"user_id", AuthUid>>`,
].join("\n")

function extract(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "supatype-channel-"))
  dirs.push(dir)
  const path = join(dir, "schema.ts")
  writeFileSync(path, `${HEADER}\n${body}\n`, "utf8")
  return extractSchemaAstFromTypes(path, dir)
}

function refusal(body: string): string {
  try {
    extract(body)
  } catch (err: unknown) {
    return errorMessage(err)
  }
  throw new Error("the schema was accepted")
}

const LOT = `export type LotChannel = Channel<"lot:{id}", {
  params: { id: UUID }
  access: {
    join: Any<[In<"id", MyLots>, Role<"auctioneer">]>
    send: Any<[
      Exists<Rows<"lots", "id", All<[Eq<"id", Param<"id">>, Eq<"seller_id", AuthUid>]>>>,
      Role<"auctioneer">,
    ]>
    track: All<[LoggedIn, In<"id", MyLots>]>
  }
}>`

describe("extracting a Channel", () => {
  it("emits the 14.1 shape for a one-parameter channel", () => {
    const channels = extract(LOT)?.channels
    expect(channels).toHaveLength(1)
    const lot = channels?.[0]
    expect(lot?.name).toBe("LotChannel")
    expect(lot?.pattern).toBe("lot:{id}")
    expect(lot?.params).toEqual([{ name: "id", type: "uuid" }])
    expect(lot?.access.join).toMatchObject({ type: "any" })
    expect(lot?.access.track).toMatchObject({ type: "all" })
  })

  it("renders Param<> inside a Rows<> filter as a param operand", () => {
    const send = JSON.stringify(extract(LOT)?.channels?.[0]?.access.send)
    expect(send).toContain('{"kind":"param","name":"id"}')
  })

  it("keeps a bare string at the top level as the parameter's column", () => {
    const join = extract(LOT)?.channels?.[0]?.access.join as { rules: Array<Record<string, unknown>> }
    expect(join.rules[0]).toMatchObject({ type: "in", column: "id" })
  })

  it("emits null for an operation left out", () => {
    const lobby = extract(`export type Lobby = Channel<"lobby", { access: { join: LoggedIn } }>`)?.channels?.[0]
    expect(lobby?.params).toEqual([])
    expect(lobby?.access).toEqual({ join: { type: "authenticated" }, send: null, track: null })
  })

  it("maps string and Int parameters", () => {
    const c = extract(`export type Room = Channel<"room:{slug}:{n}", {
      params: { slug: string; n: Int }
      access: { join: LoggedIn }
    }>`)?.channels?.[0]
    expect(c?.params).toEqual([{ name: "slug", type: "string" }, { name: "n", type: "integer" }])
  })

  it("accepts a final wildcard segment", () => {
    const c = extract(`export type Org = Channel<"org:{org}:*", {
      params: { org: UUID }
      access: { join: LoggedIn }
    }>`)?.channels?.[0]
    expect(c?.pattern).toBe("org:{org}:*")
  })

  it("accepts Param<> at the top level of a rule", () => {
    const c = extract(`export type Room = Channel<"room:{id}", {
      params: { id: UUID }
      access: { join: In<"id", MyLots>, send: Eq<"id", Param<"id">> }
    }>`)?.channels?.[0]
    expect(c?.access.send).toMatchObject({ type: "compare", right: { kind: "param", name: "id" } })
  })

  it("emits Event<> and Payload<> inside send, with the 14.1 check shapes", () => {
    const c = extract(`export type Bids = Channel<"bids", {
      access: {
        join: LoggedIn
        send: All<[
          Event<"bid">,
          Payload<"amount", { kind: "number"; min: 1; max: 1000000 }>,
          Payload<"note", { kind: "string"; maxLength: 80 }>,
          Payload<"flag", { kind: "boolean" }>,
          Payload<"who", { kind: "required" }>,
        ]>
      }
    }>`)?.channels?.[0]
    expect(c?.access.send).toEqual({
      type: "all",
      rules: [
        { type: "event", name: "bid" },
        { type: "payload", field: "amount", check: { kind: "number", min: 1, max: 1000000 } },
        { type: "payload", field: "note", check: { kind: "string", maxLength: 80 } },
        { type: "payload", field: "flag", check: { kind: "boolean" } },
        { type: "payload", field: "who", check: { kind: "required" } },
      ],
    })
  })

  it("omits the channels key when there are none", () => {
    expect(extract(`export type Other = Model<{ id: UUID }, { access: { read: LoggedIn } }>`)?.channels).toBeUndefined()
  })
})

describe("refusing a bad Channel", () => {
  it("refuses a declaration with no access", () => {
    expect(refusal(`export type C = Channel<"lobby", { params: {} }>`)).toMatch(/C.*declares no access/s)
    expect(refusal(`export type C = Channel<"lobby", { access: {} }>`)).toMatch(/C.*declares no access/s)
  })

  it("refuses an unknown operation and names the three", () => {
    const msg = refusal(`export type C = Channel<"lobby", { access: { join: LoggedIn, read: LoggedIn } }>`)
    expect(msg).toContain('"read"')
    expect(msg).toContain("join, send or track")
  })

  it("refuses a pattern parameter missing from params", () => {
    const msg = refusal(`export type C = Channel<"lot:{id}", { access: { join: LoggedIn } }>`)
    expect(msg).toContain("C")
    expect(msg).toContain("{id}")
    expect(msg).toContain("params")
  })

  it("refuses a params key the pattern does not use", () => {
    const msg = refusal(`export type C = Channel<"lobby", { params: { id: UUID }, access: { join: LoggedIn } }>`)
    expect(msg).toContain('"id"')
    expect(msg).toContain("does not appear in the pattern")
  })

  it("refuses a parameter type outside UUID, string and Int", () => {
    const msg = refusal(`export type C = Channel<"lot:{id}", { params: { id: boolean }, access: { join: LoggedIn } }>`)
    expect(msg).toContain("UUID, string or Int")
  })

  it("refuses a parameter that shares a segment with other text", () => {
    expect(refusal(`export type C = Channel<"lot-{id}", { params: { id: UUID }, access: { join: LoggedIn } }>`))
      .toContain("whole segment")
  })

  it("refuses an empty segment", () => {
    expect(refusal(`export type C = Channel<"lot::x", { access: { join: LoggedIn } }>`)).toContain("empty segment")
  })

  it("refuses a repeated parameter name", () => {
    expect(
      refusal(`export type C = Channel<"a:{id}:{id}", { params: { id: UUID }, access: { join: LoggedIn } }>`),
    ).toContain("more than once")
  })

  it("refuses reserved prefixes", () => {
    expect(refusal(`export type C = Channel<"realtime:x", { access: { join: LoggedIn } }>`)).toContain("reserved")
    expect(refusal(`export type C = Channel<"_supatype_x", { access: { join: LoggedIn } }>`)).toContain("reserved")
  })

  it("refuses a wildcard that is not the final segment", () => {
    expect(refusal(`export type C = Channel<"a:*:b", { access: { join: LoggedIn } }>`)).toContain("final segment")
  })

  it("refuses a lone wildcard", () => {
    expect(refusal(`export type C = Channel<"*", { access: { join: LoggedIn } }>`)).toContain("literal segment")
  })

  it("refuses Channel<> without a literal pattern or a config", () => {
    expect(refusal(`export type C = Channel<string, { access: { join: LoggedIn } }>`)).toContain("string literal")
    expect(refusal(`export type C = Channel<"x">`)).toContain("config")
  })

  it("refuses a bare column that is not a parameter and lists the parameters", () => {
    const msg = refusal(`export type C = Channel<"lot:{id}", {
      params: { id: UUID }
      access: { join: In<"idd", MyLots> }
    }>`)
    expect(msg).toContain('"idd"')
    expect(msg).toContain("join rule of C")
    expect(msg).toContain("Declared parameters: id")
  })

  it("refuses an unknown Param<> name", () => {
    const msg = refusal(`export type C = Channel<"lot:{id}", {
      params: { id: UUID }
      access: { join: Exists<Rows<"lots", "id", Eq<"id", Param<"nope">>>> }
    }>`)
    expect(msg).toContain('Param<"nope">')
    expect(msg).toContain("Declared parameters: id")
  })

  it("refuses Param<> in a model rule", () => {
    const msg = refusal(`export type Doc = Model<{ id: UUID; owner: UUID }, { access: { read: Eq<"owner", Param<"id">> } }>`)
    expect(msg).toContain("Param<>")
    expect(msg).toContain("Doc")
    expect(msg).toContain("only valid in a Channel")
  })

  it("refuses Event<> and Payload<> outside send", () => {
    const joinMsg = refusal(`export type C = Channel<"x", { access: { join: Event<"bid"> } }>`)
    expect(joinMsg).toContain("Event<>")
    expect(joinMsg).toContain("only valid inside send")
    const trackMsg = refusal(
      `export type C = Channel<"x", { access: { join: LoggedIn, track: Payload<"a", { kind: "required" }> } }>`,
    )
    expect(trackMsg).toContain("Payload<>")
    expect(trackMsg).toContain("only valid inside send")
  })

  it("refuses Event<> in a model rule", () => {
    const msg = refusal(`export type Doc = Model<{ id: UUID }, { access: { read: Event<"x"> } }>`)
    expect(msg).toContain("Event<>")
    expect(msg).toContain("Doc")
  })

  it("refuses Event<> under Any or Not inside send", () => {
    expect(refusal(`export type C = Channel<"x", { access: { send: Any<[Event<"a">, Role<"admin">]> } }>`))
      .toContain("All<[...]>")
    expect(refusal(`export type C = Channel<"x", { access: { send: Not<Event<"a">> } }>`)).toContain("All<[...]>")
  })

  it("refuses a malformed Payload check", () => {
    const bad = (check: string) => refusal(`export type C = Channel<"x", { access: { send: Payload<"a", ${check}> } }>`)
    expect(bad(`{ kind: "date" }`)).toContain("number, string, boolean or required")
    expect(bad(`{ kind: "number"; min: 5; max: 1 }`)).toContain("min is greater than max")
    expect(bad(`{ kind: "string"; maxLength: 0 }`)).toContain("maxLength")
    expect(bad(`{ kind: "boolean"; min: 1 }`)).toContain('"min"')
    expect(bad(`string`)).toContain("check")
  })

  it("refuses Event<> without a literal name", () => {
    expect(refusal(`export type C = Channel<"x", { access: { send: Event<string> } }>`)).toContain("string literal")
  })
})

describe("channel overlap", () => {
  const ACCESS = `{ access: { join: LoggedIn } }`

  it("refuses a parameter and a literal in the same place, naming both declarations", () => {
    const msg = refusal(`
      export type A = Channel<"lot:{id}", { params: { id: UUID }, access: { join: LoggedIn } }>
      export type B = Channel<"lot:featured", ${ACCESS}>`)
    expect(msg).toContain('"A"')
    expect(msg).toContain('"B"')
    expect(msg).toContain("lot:{id}")
    expect(msg).toContain("lot:featured")
    expect(msg).toContain("can both match")
  })

  it("refuses two patterns that differ only in parameter name", () => {
    const msg = refusal(`
      export type A = Channel<"lot:{id}", { params: { id: UUID }, access: { join: LoggedIn } }>
      export type B = Channel<"lot:{n}", { params: { n: Int }, access: { join: LoggedIn } }>`)
    expect(msg).toContain("can both match")
  })

  it("refuses a wildcard that covers another declaration", () => {
    const msg = refusal(`
      export type A = Channel<"org:*", ${ACCESS}>
      export type B = Channel<"org:{id}:chat", { params: { id: UUID }, access: { join: LoggedIn } }>`)
    expect(msg).toContain('"A"')
    expect(msg).toContain('"B"')
  })

  it("refuses two wildcards under one prefix", () => {
    const msg = refusal(`
      export type A = Channel<"org:*", ${ACCESS}>
      export type B = Channel<"org:x:*", ${ACCESS}>`)
    expect(msg).toContain("can both match")
  })

  it("allows patterns that cannot match one topic", () => {
    const ast = extract(`
      export type A = Channel<"lot:{id}", { params: { id: UUID }, access: { join: LoggedIn } }>
      export type B = Channel<"user:{id}", { params: { id: UUID }, access: { join: LoggedIn } }>
      export type C = Channel<"lot:{id}:chat", { params: { id: UUID }, access: { join: LoggedIn } }>
      export type D = Channel<"lobby", ${ACCESS}>
      export type E = Channel<"admin:*", ${ACCESS}>`)
    expect(ast?.channels?.map((c) => c.name)).toEqual(["A", "B", "C", "D", "E"])
  })

  it("lets a wildcard coexist with the bare prefix, since it needs one more segment", () => {
    const ast = extract(`
      export type A = Channel<"org", ${ACCESS}>
      export type B = Channel<"org:*", ${ACCESS}>`)
    expect(ast?.channels).toHaveLength(2)
  })
})

describe("a send rule that does not check who is sending", () => {
  const channel = (send: string) => `export type BidChannel = Channel<"bid:{id}", {
  params: { id: UUID }
  access: { join: LoggedIn, send: ${send} }
}>`
  const warningsOf = (send: string): string[] => extract(channel(send))?.warnings ?? []

  it("warns, naming the channel, when send tests only the event", () => {
    const warnings = warningsOf(`Event<"bid">`)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("BidChannel")
    expect(warnings[0]).toContain("does not check who is sending")
    expect(warnings[0]).toContain(`All<[LoggedIn, Event<"bid">]>`)
  })

  it("warns when send tests only the event and the payload", () => {
    const warnings = warningsOf(`All<[Event<"bid">, Payload<"amount", { kind: "number"; min: 1 }>]>`)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("BidChannel")
  })

  it("does not warn when the rule says Public, since the author has said anyone may send", () => {
    expect(warningsOf(`All<[Public, Event<"bid">]>`)).toEqual([])
  })

  it("does not warn when the rule tests the caller beside the content", () => {
    expect(warningsOf(`All<[LoggedIn, Event<"bid">]>`)).toEqual([])
    expect(warningsOf(`All<[Role<"auctioneer">, Event<"bid">, Payload<"amount", { kind: "number" }>]>`)).toEqual([])
  })

  it("does not warn when the rule has no content test, or no send rule", () => {
    expect(warningsOf(`LoggedIn`)).toEqual([])
    expect(extract(`export type Quiet = Channel<"quiet:{id}", { params: { id: UUID }, access: { join: LoggedIn } }>`)?.warnings).toBeUndefined()
  })
})

describe("warnings from the models and from the channels", () => {
  it("keeps both: a jsonb fallback field and a send rule that does not check the caller", () => {
    const warnings =
      extract(`export type Bid = Model<{ id: UUID, kind: "outbid" }>
export type BidChannel = Channel<"bid:{id}", {
  params: { id: UUID }
  access: { join: LoggedIn, send: Event<"bid"> }
}>`)?.warnings ?? []
    expect(warnings).toHaveLength(2)
    expect(warnings.some((w) => w.includes("Bid.kind") && w.includes("jsonb"))).toBe(true)
    expect(warnings.some((w) => w.includes("BidChannel") && w.includes("does not check who is sending"))).toBe(true)
  })
})
