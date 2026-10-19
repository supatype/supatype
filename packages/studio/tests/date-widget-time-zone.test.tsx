// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { fromLocalInput, toLocalInput } from "../src/lib/local-datetime.js"
import { DateWidget } from "../src/widgets/DateWidget.js"
import { elementOf, testField } from "./support.js"

/**
 * A date-time field in a browser outside UTC. Kitchen-sink's talk starts at 13:00 UTC; the field
 * showed 13:00 (the UTC digits) and an edit saved the typed time as local time, so in BST every
 * save moved the talk an hour earlier. The field now shows and takes local time and saves the
 * offset with it, which both column kinds read correctly.
 */

let root: Root | null = null
let container: HTMLElement

beforeAll(() => {
  // October 2026 in London is BST, one hour ahead of UTC.
  process.env["TZ"] = "Europe/London"
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
})

async function renderField(value: string, onChange: (v: unknown) => void): Promise<HTMLInputElement> {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<DateWidget config={testField({ name: "starts_at", widget: "datetime" })} value={value} onChange={onChange} readOnly={false} />)
  })
  return elementOf(container, "input", HTMLInputElement)
}

async function type(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("a timestamptz value", () => {
  it("shows the editor's local time", async () => {
    const input = await renderField("2026-10-15T13:00:00+00:00", () => {})
    expect(input.value).toBe("2026-10-15T14:00")
  })

  it("saves the typed local time as the instant it means", async () => {
    const onChange = vi.fn()
    const input = await renderField("2026-10-15T13:00:00+00:00", onChange)
    await type(input, "2026-10-15T14:30")
    const saved: unknown = onChange.mock.calls[0]?.[0]
    expect(saved).toBe("2026-10-15T14:30:00+01:00")
    expect(new Date(String(saved)).toISOString()).toBe("2026-10-15T13:30:00.000Z")
  })

  it("does not move a value that is shown and saved back unchanged", () => {
    const saved = fromLocalInput(toLocalInput("2026-10-15T13:00:00+00:00"))
    expect(new Date(String(saved)).toISOString()).toBe("2026-10-15T13:00:00.000Z")
  })
})

describe("a timestamp without a zone", () => {
  it("shows and saves the wall time as stored", async () => {
    // A `timestamp` column ignores the offset on the way in, so the wall time typed is what lands.
    const onChange = vi.fn()
    const input = await renderField("2026-10-15T13:00:00", onChange)
    expect(input.value).toBe("2026-10-15T13:00")
    await type(input, "2026-10-15T13:15")
    expect(onChange.mock.calls[0]?.[0]).toBe("2026-10-15T13:15:00+01:00")
  })
})
