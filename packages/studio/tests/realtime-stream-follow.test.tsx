// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { StreamRows } from "../src/views/realtime/Stream.js"
import { INITIAL_STREAM, type StreamState } from "../src/hooks/useRealtimeStream.js"
import type { StreamRow } from "../src/views/realtime/types.js"

/**
 * The stream follows what arrives, the way a log tail does.
 *
 * The rows were drawn newest first at the top of a list that grew down the page, so a new event
 * pushed everything below it and a reader part way down never saw it arrive. The newest row is now
 * at the bottom of the stream's own scroll area, which stays at the bottom while it is there and
 * stops following once the reader scrolls up to read, with a control to jump back.
 */

let root: Root | null = null
let container: HTMLElement

function broadcast(seq: number): StreamRow {
  return {
    kind: "broadcast",
    broadcast: { seq, at: "2026-10-20T08:00:00Z", channel: `room:mt18-${seq}`, event: "message", origin: "client", senderConnectionId: null, recipients: 1, bytes: 10 },
  }
}

/** Newest first, as the stream's reducer keeps them. */
function stateWith(...seqs: number[]): StreamState {
  return { ...INITIAL_STREAM, status: "streaming", rows: seqs.map(broadcast) }
}

/** jsdom lays nothing out, so the scroll area is given the geometry a browser would. */
function scroller(): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-stream-scroller]")
  if (!el) throw new Error("no stream scroll area")
  return el
}

function giveGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight })
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight })
}

async function show(state: StreamState): Promise<void> {
  await act(async () => root!.render(<StreamRows state={state} />))
}

async function mount(state: StreamState): Promise<void> {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await show(state)
}

function jumpButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith("Jump to latest"))
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
})

describe("following the stream", () => {
  it("draws the newest event last, under the ones before it", async () => {
    await mount(stateWith(3, 2, 1))
    const channels = [...container.querySelectorAll(".font-mono")].map((el) => el.textContent)
    expect(channels).toEqual(["room:mt18-1", "room:mt18-2", "room:mt18-3"])
  })

  it("keeps the newest event in view as events arrive", async () => {
    await mount(stateWith(1))
    giveGeometry(scroller(), 800, 300)
    await show(stateWith(2, 1))
    expect(scroller().scrollTop).toBe(800)
    expect(jumpButton()).toBeUndefined()
  })

  it("stops following when the reader scrolls up, and offers a jump back", async () => {
    await mount(stateWith(1))
    const el = scroller()
    giveGeometry(el, 800, 300)
    el.scrollTop = 100
    await act(async () => { el.dispatchEvent(new Event("scroll")) })
    await show(stateWith(3, 2, 1))
    expect(el.scrollTop).toBe(100)
    expect(jumpButton()?.textContent).toBe("Jump to latest (2 new)")
    await act(async () => jumpButton()!.click())
    expect(el.scrollTop).toBe(800)
    expect(jumpButton()).toBeUndefined()
  })

  it("follows again once the reader scrolls back to the bottom", async () => {
    await mount(stateWith(1))
    const el = scroller()
    giveGeometry(el, 800, 300)
    el.scrollTop = 100
    await act(async () => { el.dispatchEvent(new Event("scroll")) })
    el.scrollTop = 500
    await act(async () => { el.dispatchEvent(new Event("scroll")) })
    giveGeometry(el, 900, 300)
    await show(stateWith(2, 1))
    expect(el.scrollTop).toBe(900)
  })
})
