import { connect } from "node:net"
import { describe, expect, it } from "vitest"
import { errorMessage } from "../src/error-message.js"

/**
 * Local test N4: an error whose message is empty printed as a blank line. Node reports a refused
 * connection to `localhost` as an AggregateError with an empty message, one inner error per address
 * it tried, so `supatype push` printed `[supatype] ` and `admin list-users` printed
 * `Failed to list admin users: ` with nothing after either.
 */

/** A connection error from Node itself, to a port nothing listens on. */
function refusedConnection(host: string): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 1 })
    socket.once("error", resolve)
    socket.once("connect", () => {
      socket.destroy()
      resolve(new Error("something listens on port 1"))
    })
  })
}

/** An errno error as Node builds one, with no message of its own. */
function errnoError(code: string, address: string, port: number): Error {
  return Object.assign(new Error(""), { code, address, port })
}

describe("errorMessage", () => {
  it("keeps an error's own message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage("text")).toBe("text")
  })

  it("names what was refused and where for a real refused connection", async () => {
    const err = await refusedConnection("127.0.0.1")
    expect(errorMessage(err)).toMatch(/connect(ion)? (ECONNREFUSED|refused).*127\.0\.0\.1:1/)
  })

  it("describes an AggregateError with an empty message by its inner errors", () => {
    const err = Object.assign(
      new AggregateError([errnoError("ECONNREFUSED", "::1", 5432), errnoError("ECONNREFUSED", "127.0.0.1", 5432)], ""),
      { code: "ECONNREFUSED" },
    )
    expect(errorMessage(err)).toBe("connection refused at [::1]:5432, 127.0.0.1:5432")
  })

  it("never answers an empty string", async () => {
    expect(errorMessage(await refusedConnection("localhost"))).toMatch(/connection refused at .*:1/)
    expect(errorMessage(Object.assign(new Error(""), { code: "EWHATEVER" }))).toBe("EWHATEVER")
    expect(errorMessage(new Error(""))).toBe("Error")
  })

  it("keeps the inner messages when they say something the codes do not", () => {
    const err = new AggregateError([new Error("first went wrong"), new Error("second went wrong")], "")
    expect(errorMessage(err)).toBe("first went wrong; second went wrong")
  })
})
