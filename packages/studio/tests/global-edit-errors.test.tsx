// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { GlobalConfig } from "../src/config.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import { GlobalEditView } from "../src/views/GlobalEditView.js"
import { elementOf, testClient, testConfig, testField } from "./support.js"

/**
 * Site settings showed a refused save as the server's raw text in the banner, and never under the
 * input it was about: a PostGIS parse failure read `parse error - invalid geometry` from a 500, and
 * the form's own checks put nothing beside the field either. A refusal now goes under its input
 * where the answer allows, in words that follow the field's label.
 */

const SETTINGS: GlobalConfig = {
  name: "siteSettings",
  label: "Site settings",
  tableName: "_global_site_settings",
  apiPath: "/rest/v1/_global_site_settings",
  fields: [
    testField({ name: "id", widget: "uuid" }),
    testField({ name: "title", label: "Title", required: true }),
    testField({ name: "venue", label: "Venue", widget: "geopoint" }),
  ],
}
const ROW = { id: "s1", title: "Supatype Conf", venue: "0101000020E6100000DA1B7C613255C0BFFE43FAEDEBC04940" }
const LOCALE = { currentLocale: "en", setLocale: () => {}, locales: [{ code: "en", label: "English" }], defaultLocale: "en" }

let root: Root | null = null
let container: HTMLElement
let writes: unknown[] = []

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

/** The row on read; `refusal` as the answer to a write, with its status. */
function stubFetch(refusal: { status: number; body: Record<string, unknown> }): void {
  writes = []
  vi.stubGlobal("fetch", async (raw: string, init?: RequestInit) => {
    const url = new URL(raw)
    if (!url.pathname.endsWith("/rest/v1/_global_site_settings")) return Response.json([])
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)))
      return Response.json(refusal.body, { status: refusal.status })
    }
    return Response.json(ROW)
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function open(): Promise<void> {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <AdminConfigContext.Provider value={testConfig({ globals: [SETTINGS] })}>
        <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
          <LocaleContext.Provider value={LOCALE}>
            <GlobalEditView global={SETTINGS} />
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>,
    )
  })
  await settle()
}

async function type(selector: string, text: string): Promise<void> {
  const input = elementOf(container, selector, HTMLInputElement)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function save(): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save")
  await act(async () => button?.click())
  await settle()
}

function banner(): string | null {
  return container.querySelector('[data-ui="error-banner-message"]')?.textContent ?? null
}

/** The server's own text behind the banner's details toggle. */
function details(): string | null {
  return container.querySelector('[data-ui="error-banner"] details')?.textContent ?? null
}

function fieldError(name: string): string | null {
  return container.querySelector(`#field-${name}-error`)?.textContent ?? null
}

describe("saving Site settings", () => {
  it("puts a not-null refusal under the field it names, in words", async () => {
    stubFetch({
      status: 400,
      body: { code: "23502", message: 'null value in column "title" of relation "_global_site_settings" violates not-null constraint' },
    })
    await open()
    await type("#field-title", "")
    await save()
    expect(banner()).toBe("Title is required")
    expect(fieldError("title")).toBe("is required")
  })

  it("puts a geometry parse failure, a 500, under the point field rather than raw in the banner", async () => {
    stubFetch({
      status: 500,
      body: { code: "XX000", message: "parse error - invalid geometry", hint: '"SR" <-- parse error at position 2 within geometry' },
    })
    await open()
    await save()
    expect(banner()).toBe("Venue is not a point the database can read. Enter a latitude and a longitude.")
    expect(fieldError("venue")).toBe("is not a point the database can read. Enter a latitude and a longitude.")
  })

  it("refuses an out-of-range latitude before sending anything, under the field", async () => {
    stubFetch({ status: 201, body: {} })
    await open()
    await type("#field-venue", "95")
    await save()
    expect(writes).toEqual([])
    expect(fieldError("venue")).toBe("needs a valid point: latitude must be between -90 and 90")
    expect(banner()).toBe("Venue needs a valid point: latitude must be between -90 and 90")
  })

  it("says a refusal it cannot place in plain words, with the server's text as details", async () => {
    stubFetch({ status: 403, body: { code: "42501", message: "permission denied for table _global_site_settings" } })
    await open()
    await save()
    expect(banner()).toBe("You do not have permission to make this change.")
    expect(details()).toContain("permission denied for table _global_site_settings")
    expect(fieldError("venue")).toBeNull()
  })

  it("never shows raw SQL for a refusal it has no words for", async () => {
    stubFetch({ status: 500, body: { code: "40001", message: "could not serialize access due to concurrent update" } })
    await open()
    await save()
    expect(banner()).toBe("The database refused this change.")
    expect(details()).toContain("could not serialize access")
  })
})
