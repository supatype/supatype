import { describe, expectTypeOf, it } from "vitest"
import type {
  Any,
  All,
  Channel,
  ChannelConfig,
  ChannelParamNames,
  Eq,
  Event,
  In,
  Int,
  LoggedIn,
  Param,
  Payload,
  PayloadCheck,
  Role,
  Rows,
  UUID,
} from "../src/index.js"

type Mine = Rows<"lot_watchers", "lot_id", Eq<"user_id", Param<"id">>>

describe("ChannelParamNames", () => {
  it("reads the names out of a pattern", () => {
    expectTypeOf<ChannelParamNames<"lot:{id}">>().toEqualTypeOf<"id">()
    expectTypeOf<ChannelParamNames<"room:{org}:{slug}:chat">>().toEqualTypeOf<"org" | "slug">()
    expectTypeOf<ChannelParamNames<"lobby">>().toEqualTypeOf<never>()
    expectTypeOf<ChannelParamNames<"org:{org}:*">>().toEqualTypeOf<"org">()
  })
})

describe("Channel", () => {
  it("accepts a declared channel with parameters", () => {
    type Lot = Channel<"lot:{id}", {
      params: { id: UUID }
      access: {
        join: Any<[In<"id", Mine>, Role<"auctioneer">]>
        send: All<[Event<"bid">, Payload<"amount", { kind: "number"; min: 1 }>]>
      }
    }>
    expectTypeOf<Lot>().not.toBeNever()
  })

  it("accepts a channel with no parameters", () => {
    expectTypeOf<Channel<"lobby", { access: { join: LoggedIn } }>>().not.toBeNever()
  })

  it("takes UUID, string and Int parameters", () => {
    expectTypeOf<{ a: UUID; b: string; c: Int }>().toExtend<NonNullable<ChannelConfig<"x:{a}:{b}:{c}">["params"]>>()
  })

  it("refuses a params key the pattern does not name", () => {
    // @ts-expect-error `nope` is not a parameter of the pattern
    type Bad = Channel<"lot:{id}", { params: { id: UUID; nope: UUID }; access: { join: LoggedIn } }>
    void (undefined as unknown as Bad)
  })

  it("refuses a parameter the pattern names but params leaves out", () => {
    // @ts-expect-error `id` has no type
    type Bad = Channel<"lot:{id}", { params: {}; access: { join: LoggedIn } }>
    void (undefined as unknown as Bad)
  })

  it("refuses a parameter of any other type", () => {
    // @ts-expect-error a boolean cannot sit in a channel name
    type Bad = Channel<"lot:{id}", { params: { id: boolean }; access: { join: LoggedIn } }>
    void (undefined as unknown as Bad)
  })

  it("refuses a config with no access", () => {
    // @ts-expect-error access is required
    type Bad = Channel<"lobby", {}>
    void (undefined as unknown as Bad)
  })

  it("refuses Event<> in join and track, where it means nothing", () => {
    // @ts-expect-error Event is only valid inside send
    type Bad = Channel<"lobby", { access: { join: Event<"x"> } }>
    void (undefined as unknown as Bad)
  })
})

describe("Payload checks", () => {
  it("are the four kinds the server can evaluate", () => {
    expectTypeOf<PayloadCheck["kind"]>().toEqualTypeOf<"string" | "number" | "boolean" | "required">()
  })

  it("carry only the bounds that kind has", () => {
    expectTypeOf<{ kind: "number"; min: 1; max: 9 }>().toExtend<PayloadCheck>()
    expectTypeOf<{ kind: "string"; maxLength: 80 }>().toExtend<PayloadCheck>()
    expectTypeOf<{ kind: "boolean" }>().toExtend<PayloadCheck>()
    expectTypeOf<{ kind: "required" }>().toExtend<PayloadCheck>()
  })
})
