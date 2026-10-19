// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import type { FieldConfig } from "../src/config.js"
import { normalizeAdminConfig } from "../src/lib/normalize-admin-config.js"
import { formatFieldValue } from "../src/lib/field-display.js"
import { validateRecord } from "../src/lib/validate-record.js"
import { FieldWidget } from "../src/widgets/FieldWidget.js"
import { elementOf, testField } from "./support.js"

/**
 * Kitchen-sink's talk Length is a `Duration` (`{ ms }`) and Site settings' Venue a `GeoPoint`
 * (hex EWKB). Studio had a widget for neither: Length read `[object Object]` and Venue a 50-digit
 * hex string, and a venue typed as text was either refused with a raw 500 or silently wrapped
 * round the globe.
 */

const LENGTH = testField({ name: "length", label: "Length", widget: "duration" })
const VENUE = testField({ name: "venue", label: "Venue", widget: "geopoint" })
/** Real PostGIS output for SRID=4326;POINT(-0.1276 51.5072). */
const LONDON_HEX = "0101000020E6100000DA1B7C613255C0BFFE43FAEDEBC04940"

let root: Root | null = null
let container: HTMLElement

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
})

interface Rendered {
  changes: unknown[]
  rerender: (value: unknown) => Promise<void>
}

async function render(config: FieldConfig, value: unknown, readOnly = false): Promise<Rendered> {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  const changes: unknown[] = []
  const draw = async (v: unknown): Promise<void> => {
    await act(async () => {
      root!.render(<FieldWidget config={config} value={v} onChange={(next) => changes.push(next)} readOnly={readOnly} />)
    })
  }
  await draw(value)
  return { changes, rerender: draw }
}

function input(selector: string): HTMLInputElement {
  return elementOf(container, selector, HTMLInputElement)
}

async function type(el: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(el, text)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function blur(el: HTMLInputElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
  })
}

function alertText(): string | null {
  return container.querySelector("[role=alert]")?.textContent ?? null
}

describe("the engine's widget names", () => {
  it("keeps duration and geopoint rather than reading them as text", () => {
    const config = normalizeAdminConfig({
      models: [{ name: "talk", fields: [{ name: "length", widget: "duration" }, { name: "venue", widget: "geopoint" }] }],
    })
    expect(config.models[0]?.fields.map((f) => f.widget)).toEqual(["duration", "geopoint"])
  })
})

describe("a Duration field", () => {
  it("shows the stored value as 1h 30m, not [object Object]", async () => {
    await render(LENGTH, { ms: 5_400_000 })
    expect(input("#field-length").value).toBe("1h 30m")
  })

  it("stores what is typed as { ms } and shows it back normalised on blur", async () => {
    const { changes, rerender } = await render(LENGTH, { ms: 2_700_000 })
    await type(input("#field-length"), "90m")
    expect(changes.at(-1)).toEqual({ ms: 5_400_000 })
    await rerender(changes.at(-1))
    expect(input("#field-length").value).toBe("90m")
    await blur(input("#field-length"))
    expect(input("#field-length").value).toBe("1h 30m")
  })

  it("refuses text it cannot read, inline, and hands the text on so Save is refused too", async () => {
    const { changes } = await render(LENGTH, { ms: 2_700_000 })
    await type(input("#field-length"), "about an hour")
    expect(alertText()).toMatch(/Could not read "about an hour"/)
    expect(input("#field-length").getAttribute("aria-invalid")).toBe("true")
    expect(changes.at(-1)).toBe("about an hour")
    expect(validateRecord([LENGTH], { length: changes.at(-1) })).toEqual([
      { field: "length", label: "Length", message: "must be a duration such as 1h 30m, 90m or 1:30:00" },
    ])
  })

  it("clears to null", async () => {
    const { changes } = await render(LENGTH, { ms: 2_700_000 })
    await type(input("#field-length"), "")
    expect(changes.at(-1)).toBeNull()
    expect(alertText()).toBeNull()
  })

  it("follows a value that changes from outside, such as a record loading", async () => {
    const { rerender } = await render(LENGTH, null)
    await rerender({ ms: 45_000 })
    expect(input("#field-length").value).toBe("45s")
  })

  it("reads the same in a list cell", () => {
    expect(formatFieldValue(LENGTH, { ms: 5_400_000 })).toBe("1h 30m")
    expect(formatFieldValue(LENGTH, "not stored as ms")).toBeNull()
  })
})

describe("a GeoPoint field", () => {
  it("decodes the stored hex into latitude and longitude", async () => {
    await render(VENUE, LONDON_HEX)
    expect(input("#field-venue").value).toBe("51.5072")
    expect(input("#field-venue-lng").value).toBe("-0.1276")
    expect(container.textContent).toContain("51.5072° N, 0.1276° W")
  })

  it("writes a valid edit as EWKT, longitude first", async () => {
    const { changes } = await render(VENUE, LONDON_HEX)
    await type(input("#field-venue"), "52.2")
    expect(changes.at(-1)).toBe("SRID=4326;POINT(-0.1276 52.2)")
  })

  it("refuses a latitude out of range instead of letting PostGIS wrap it", async () => {
    const { changes } = await render(VENUE, LONDON_HEX)
    await type(input("#field-venue"), "95")
    expect(alertText()).toBe("Latitude must be between -90 and 90")
    expect(changes.at(-1)).toEqual({ lat: "95", lng: "-0.1276" })
    const [violation] = validateRecord([VENUE], { venue: changes.at(-1) })
    expect(violation?.message).toBe("needs a valid point: latitude must be between -90 and 90")
  })

  it("refuses a longitude out of range", async () => {
    await render(VENUE, LONDON_HEX)
    await type(input("#field-venue-lng"), "-181")
    expect(alertText()).toBe("Longitude must be between -180 and 180")
  })

  it("asks for both when one box is empty, and clears to null when both are", async () => {
    const { changes } = await render(VENUE, LONDON_HEX)
    await type(input("#field-venue-lng"), "")
    expect(alertText()).toBe("Enter a longitude too, or clear both")
    await type(input("#field-venue"), "")
    expect(changes.at(-1)).toBeNull()
    expect(alertText()).toBeNull()
  })

  it("starts empty for an optional field with no point", async () => {
    const { changes } = await render(VENUE, null)
    expect(input("#field-venue").value).toBe("")
    await type(input("#field-venue"), "40.7128")
    await type(input("#field-venue-lng"), "-74.006")
    expect(changes.at(-1)).toBe("SRID=4326;POINT(-74.006 40.7128)")
  })

  it("is read-only when the field is", async () => {
    await render(VENUE, LONDON_HEX, true)
    expect(input("#field-venue").readOnly).toBe(true)
    expect(input("#field-venue-lng").readOnly).toBe(true)
  })

  it("reads the same in a list cell", () => {
    expect(formatFieldValue(VENUE, LONDON_HEX)).toBe("51.5072° N, 0.1276° W")
  })
})

describe("an engine from before the geopoint widget", () => {
  const OLD_VENUE = testField({ name: "venue", label: "Venue", widget: "text" })

  it("still edits a point column as a point, told apart by its value", async () => {
    await render(OLD_VENUE, LONDON_HEX)
    expect(input("#field-venue").value).toBe("51.5072")
    expect(formatFieldValue(OLD_VENUE, LONDON_HEX)).toBe("51.5072° N, 0.1276° W")
  })

  it("leaves ordinary text alone", async () => {
    await render(OLD_VENUE, "The Old Vic")
    expect(input("#field-venue").value).toBe("The Old Vic")
    expect(formatFieldValue(OLD_VENUE, "deadbeef")).toBeNull()
  })
})
