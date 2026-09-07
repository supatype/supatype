import { describe, expect, it } from "vitest"
import { parseTailEvents } from "../src/hooks/useFunctionLogTail.js"

// Server-sent events are separated by a blank line, and a network chunk can split one anywhere: in
// the middle of a JSON object, between the `data:` prefix and its payload, or exactly on the
// separator. A parser that assumes one chunk is one event drops lines under load and only under
// load, which is the worst way to find out.

const line = (fn: string, message: string): string =>
  JSON.stringify({
    timestamp: "2026-09-07T17:04:23.020Z",
    level: "info",
    project_ref: "blog",
    function: fn,
    message,
  })

describe("parsing the log tail", () => {
  it("reads a whole event", () => {
    const { lines, rest } = parseTailEvents(`data: ${line("greet", "hello")}\n\n`, "greet")
    expect(lines.map((l) => l.message)).toEqual(["hello"])
    expect(rest).toBe("")
  })

  it("holds a partial event back until the rest arrives", () => {
    const whole = `data: ${line("greet", "hello")}\n\n`
    const cut = Math.floor(whole.length / 2)

    const first = parseTailEvents(whole.slice(0, cut), "greet")
    expect(first.lines).toEqual([])

    const second = parseTailEvents(first.rest + whole.slice(cut), "greet")
    expect(second.lines.map((l) => l.message)).toEqual(["hello"])
  })

  it("reads several events arriving in one chunk", () => {
    const chunk = `data: ${line("greet", "one")}\n\ndata: ${line("greet", "two")}\n\n`
    expect(parseTailEvents(chunk, "greet").lines.map((l) => l.message)).toEqual(["one", "two"])
  })

  it("keeps only this function's lines", () => {
    // The stream carries every function's output and the worker's own startup lines. Somebody
    // else's output in this tab reads as this function's.
    const chunk =
      `data: ${line("greet", "mine")}\n\n` +
      `data: ${line("other", "theirs")}\n\n` +
      `data: ${JSON.stringify({ timestamp: "t", level: "info", project_ref: "blog", message: "worker" })}\n\n`
    expect(parseTailEvents(chunk, "greet").lines.map((l) => l.message)).toEqual(["mine"])
  })

  it("ignores the retry and comment lines a stream carries", () => {
    // `retry:` sets the reconnect delay and `:` is a keep-alive comment. Neither is a log line, and
    // neither is JSON.
    const chunk = `retry: 2000\n\n: keep-alive\n\ndata: ${line("greet", "hello")}\n\n`
    expect(parseTailEvents(chunk, "greet").lines.map((l) => l.message)).toEqual(["hello"])
  })

  it("survives a line that is not JSON at all", () => {
    // A truncated write, or something upstream injecting text. Losing one line is acceptable;
    // taking the tail down is not.
    const chunk = `data: {"broken\n\ndata: ${line("greet", "after")}\n\n`
    expect(parseTailEvents(chunk, "greet").lines.map((l) => l.message)).toEqual(["after"])
  })
})
