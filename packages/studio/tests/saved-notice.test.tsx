// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { SavedNotice, SAVED_NOTICE_MS } from "../src/components/ui.js"

/**
 * D-50: a save said nothing, so a real save looked like nothing happened. The notice shows "Saved"
 * beside the Save button for three seconds. A failed save never sets it, so its error stands alone.
 */

let host: HTMLDivElement
let root: Root

function show(at: number | null): void {
  act(() => { root.render(<SavedNotice at={at} />) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-23T12:00:00Z"))
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.useRealTimers()
})

describe("SavedNotice", () => {
  it("shows nothing before any save", () => {
    show(null)
    expect(host.textContent).toBe("")
  })

  it("says Saved once a save lands, as a status message", () => {
    show(Date.now())
    const status = host.querySelector("[role=status]")
    expect(status?.textContent).toBe("Saved")
  })

  it("hides after three seconds, not before", () => {
    show(Date.now())
    act(() => { vi.advanceTimersByTime(SAVED_NOTICE_MS - 1) })
    expect(host.textContent).toBe("Saved")
    act(() => { vi.advanceTimersByTime(1) })
    expect(host.textContent).toBe("")
    expect(SAVED_NOTICE_MS).toBe(3000)
  })

  it("shows again for a later save and restarts the three seconds", () => {
    show(Date.now())
    act(() => { vi.advanceTimersByTime(2500) })
    show(Date.now())
    act(() => { vi.advanceTimersByTime(2500) })
    expect(host.textContent).toBe("Saved")
    act(() => { vi.advanceTimersByTime(500) })
    expect(host.textContent).toBe("")
  })

  it("clears at once when the save is reset, as a new save attempt does", () => {
    show(Date.now())
    show(null)
    expect(host.textContent).toBe("")
  })
})
