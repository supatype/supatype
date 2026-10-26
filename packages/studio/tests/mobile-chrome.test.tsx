// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { StudioCore } from "../src/StudioCore.js"
import type { AdminConfig } from "../src/config.js"
import { testClient, testConfig, testModel } from "./support.js"

/**
 * Studio's chrome at phone width: the burger's primary menu, the section panel and its toggle,
 * the header and search. jsdom applies no media queries, so what a phone sees is read from the
 * elements and their responsive classes, and the overlays are driven by clicking.
 */

const CONFIG = testConfig({ models: [testModel({ name: "page", label: "Page", labelPlural: "Pages" })] })
const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

let root: Root | null = null
let container: HTMLElement

async function studioAt(path: string, config: AdminConfig = CONFIG): Promise<void> {
  vi.stubGlobal("fetch", async () => new Promise<Response>(() => {}))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <StudioCore config={config} client={CLIENT} />
      </MemoryRouter>,
    ),
  )
  for (let i = 0; i < 5; i++) await act(async () => {})
}

function byLabel(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}

async function click(label: string): Promise<void> {
  const el = byLabel(label)
  if (el === null) throw new Error(`no element labelled ${label}`)
  await act(async () => el.click())
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container.remove()
  vi.unstubAllGlobals()
})

describe("the section panel toggle", () => {
  it.each(["/", "/webhooks", "/email"])("is absent on %s, which has no section panel to open", async (path) => {
    await studioAt(path)
    expect(byLabel("Toggle section navigation")).toBeNull()
  })

  it.each(["/media-storage", "/database/overview", "/settings", "/models/page"])("is offered on %s, whose section has one", async (path) => {
    await studioAt(path)
    expect(byLabel("Toggle section navigation")).not.toBeNull()
  })
})

/** The phone-width primary menu: the second Sidebar, the one that is a fixed overlay. */
function primaryDrawer(): HTMLElement | null {
  const drawers = [...document.querySelectorAll<HTMLElement>('[aria-label="Studio navigation"]')]
  return drawers.find((el) => el.className.includes("fixed")) ?? null
}

/** The section panel while it is a phone-width overlay rather than docked. */
function sectionOverlay(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>("div")].find((el) => el.className.includes("w-[200px]") && el.className.includes("fixed")) ?? null
}

describe("the phone-width menus", () => {
  it("opening the primary menu over an open section panel closes the panel, so the menu is reachable", async () => {
    await studioAt("/media-storage")
    await click("Toggle section navigation")
    expect(sectionOverlay()).not.toBeNull()
    await click("Toggle sidebar")
    expect(primaryDrawer()).not.toBeNull()
    expect(sectionOverlay()).toBeNull()
  })

  it("opening the section panel closes the primary menu", async () => {
    await studioAt("/media-storage")
    await click("Toggle sidebar")
    await click("Toggle section navigation")
    expect(primaryDrawer()).toBeNull()
    expect(sectionOverlay()).not.toBeNull()
  })

  it("choosing an item in the section panel closes it, rather than leaving it over the page it opened", async () => {
    await studioAt("/database/overview")
    await click("Toggle section navigation")
    const tables = [...sectionOverlay()!.querySelectorAll("button")].find((b) => b.textContent === "Tables")
    await act(async () => tables!.click())
    expect(sectionOverlay()).toBeNull()
  })

  it("the primary menu names every entry beside its icon, since a touch screen has no hover", async () => {
    await studioAt("/")
    await click("Toggle sidebar")
    const text = primaryDrawer()!.textContent ?? ""
    for (const label of ["Dashboard", "Models", "Database", "Media & Storage", "Authentication", "Settings"]) {
      expect(text).toContain(label)
    }
  })

  it("the docked rail stays icons only until hovered", async () => {
    await studioAt("/")
    const rail = document.querySelector<HTMLElement>('[aria-label="Studio navigation"]')!
    expect(rail.textContent).toBe("")
  })

  it("Escape closes whichever is open", async () => {
    await studioAt("/media-storage")
    await click("Toggle section navigation")
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })))
    expect(sectionOverlay()).toBeNull()
  })
})

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function searchSheet(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
}

describe("search at phone width", () => {
  it("the header offers the inline box only from md up, and a search button below it", async () => {
    await studioAt("/models/page")
    const inline = document.querySelector<HTMLInputElement>("header input[placeholder='Jump to…']")!
    expect(inline.closest(".hidden.md\\:block")).not.toBeNull()
    expect(byLabel("Search")!.className).toContain("md:hidden")
  })

  it("the button opens a full-width sheet whose results lie in its flow at full width", async () => {
    await studioAt("/models/page")
    await click("Search")
    const sheet = searchSheet()!
    expect(sheet.className).toContain("max-w-full")
    const input = sheet.querySelector<HTMLInputElement>("input")!
    expect(document.activeElement).toBe(input)
    await typeInto(input, "Users")
    const row = [...sheet.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Users"))!
    expect(row.parentElement!.className).not.toContain("absolute")
  })

  it("choosing a result closes the sheet", async () => {
    await studioAt("/models/page")
    await click("Search")
    await typeInto(searchSheet()!.querySelector<HTMLInputElement>("input")!, "Users")
    const row = [...searchSheet()!.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Users"))!
    await act(async () => row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(searchSheet()).toBeNull()
  })
})

/** The classes on `el`, so a test can say what shows below `sm` and what from `sm` up. */
function classes(el: Element | null): string[] {
  return (el?.getAttribute("class") ?? "").split(" ")
}

describe("the header at phone width", () => {
  it("collapses Connect, Feedback and the docs into one overflow menu shown only below sm", async () => {
    await studioAt("/models/page")
    expect(classes(byLabel("More"))).toContain("sm:hidden")
    expect(classes(byLabel("Documentation"))).toContain("hidden")
    const feedback = [...document.querySelectorAll("header a")].find((a) => a.textContent === "Feedback")!
    expect(classes(feedback)).toContain("hidden")
  })

  it("the overflow menu reaches Connect, Feedback and the docs", async () => {
    await studioAt("/models/page")
    const more = byLabel("More")!
    await act(async () => { more.focus(); more.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)
    expect(items).toEqual(["Connect", "Feedback", "Documentation"])
  })

  it("drops Studio's name and branch below sm, and keeps the account menu", async () => {
    await studioAt("/models/page")
    const studio = [...document.querySelectorAll("header span")].find((s) => s.textContent === "Studio")!
    expect(classes(studio)).toContain("hidden")
    expect(byLabel("Account menu")).not.toBeNull()
  })

  it("builds the locale picker on the shared Select, with its label shown only from sm up", async () => {
    const locale = { defaultLocale: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "French" }] }
    await studioAt("/models/page", { ...CONFIG, locale })
    const select = document.querySelector("header select")!
    expect(select.getAttribute("data-ui")).toBe("select")
    expect(classes(document.querySelector('header label[for="st-locale-select"]'))).toContain("sr-only")
  })
})
