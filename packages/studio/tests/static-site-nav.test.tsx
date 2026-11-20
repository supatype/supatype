// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { StudioCore } from "../src/StudioCore.js"
import type { StudioExtension } from "../src/types.js"
import type { HostRead, StaticSiteHost, StaticSiteOverview, StaticSiteSettings } from "../src/lib/static-site-host.js"
import { act, isolateEachTest, mount, settle, testClient, testConfig } from "./support.js"

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

function backend(url: string): Promise<Response> {
  if (url.endsWith("/studio/auth/verify")) {
    return Promise.resolve(Response.json({ role: "admin", sub: "u1", permissions: { administer: true } }))
  }
  return new Promise<Response>(() => {})
}

function read<T>(data: T): HostRead<T> {
  return { data, loading: false, error: null }
}

const NONE_OVERVIEW: StaticSiteOverview = {
  address: null,
  mode: "none",
  staticDir: null,
  upstream: null,
  serving: false,
  fileCount: null,
  totalBytes: null,
}

const SETTINGS: StaticSiteSettings = { mode: "static", spaFallback: true, headers: [], fromConfig: [] }

const host: StaticSiteHost = {
  useOverview: () => read(NONE_OVERVIEW),
  useSettings: () => read(SETTINGS),
}

isolateEachTest()

async function studioAt(path: string, opts: { host?: StaticSiteHost; extensions?: StudioExtension }): Promise<HTMLElement> {
  vi.stubGlobal("fetch", backend)
  const { container } = await mount(
    <MemoryRouter initialEntries={[path]}>
      <StudioCore
        config={testConfig()}
        client={CLIENT}
        {...(opts.host !== undefined && { staticSite: opts.host })}
        {...(opts.extensions !== undefined && { extensions: opts.extensions })}
      />
    </MemoryRouter>,
  )
  await settle()
  return container
}

function mainText(container: HTMLElement): string {
  return container.querySelector("main")?.textContent ?? ""
}

const RAIL = 'aside[aria-label="Studio navigation"]'

const EXTENSION: StudioExtension = {
  sidebarSections: [
    { title: "Cloud", mode: "developer", items: [{ href: "/foo", label: "Foo" }, { href: "/foo/bar", label: "Foo bar" }] },
  ],
}

describe("extension sidebar sections", () => {
  it("show no heading text", async () => {
    const container = await studioAt("/", { extensions: EXTENSION })
    // The rail shows labels while hovered, which is when a heading would appear.
    const panel = container.querySelector(`${RAIL} > div`)
    await act(() => panel?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })))
    expect(container.querySelector(RAIL)?.textContent ?? "").toContain("Foo bar")
    expect(container.querySelector(RAIL)?.textContent ?? "").not.toContain("Cloud")
  })

  it("are set apart by a divider each", async () => {
    const two: StudioExtension = {
      sidebarSections: [
        { title: "A", mode: "developer", items: [{ href: "/a", label: "Item A" }] },
        { title: "B", mode: "developer", items: [{ href: "/b", label: "Item B" }] },
      ],
    }
    const rail = (await studioAt("/", { extensions: two })).querySelector(RAIL)
    const dividers = (el: Element | null): number => Array.from(el?.querySelectorAll("div.border-t") ?? []).filter((d) => d.className.includes("mx-3")).length
    const without = dividers((await studioAt("/", {})).querySelector(RAIL))
    expect(dividers(rail)).toBe(without + 2)
  })

  it("mark only the longest matching href as current", async () => {
    const container = await studioAt("/foo/bar", { extensions: EXTENSION })
    const current = Array.from(container.querySelectorAll(`${RAIL} button[aria-current=page]`)).map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "")
    expect(current.filter((c) => c.startsWith("Foo"))).toEqual(["Foo bar"])
  })
})

describe("core rail icons", () => {
  it("draw a different icon for every item", async () => {
    const container = await studioAt("/", { host })
    const icons = new Map<string, string>()
    for (const button of Array.from(container.querySelectorAll(`${RAIL} button`))) {
      const svg = button.querySelector("svg")?.innerHTML
      if (svg === undefined) continue
      icons.set(button.getAttribute("aria-label") ?? button.textContent ?? "", svg)
    }
    expect(icons.size).toBeGreaterThan(6)
    expect(new Set(icons.values()).size).toBe(icons.size)
  })
})

describe("core rail placeholders", () => {
  const PLACEHOLDERS = ["Email", "Webhooks", "Scheduled Jobs", "Intelligence", "Commerce", "Analytics", "Branching", "Integrations", "Observability"]
  // The docked rail shows icons; each item is named by its aria-label.
  const railText = (container: HTMLElement): string =>
    Array.from(container.querySelectorAll(`${RAIL} button`)).map((b) => b.getAttribute("aria-label") ?? "").join("|")

  it("leave out every entry whose page is not built yet", async () => {
    const rail = railText(await studioAt("/", { host }))
    for (const label of PLACEHOLDERS) expect(rail).not.toContain(label)
  })

  it("keep every entry that works", async () => {
    const rail = railText(await studioAt("/", { host }))
    for (const label of ["Models", "Database", "Media & Storage", "Edge Functions", "Static site", "Plugins"]) {
      expect(rail).toContain(label)
    }
  })

  it("leave no divider at either end or two in a row", async () => {
    const container = await studioAt("/", { host })
    // The dividers between groups; the pinned Settings block has a top border of its own.
    const dividers = Array.from(container.querySelectorAll(`${RAIL} div.my-1.border-t`))
    expect(dividers.length).toBeGreaterThan(0)
    for (const divider of dividers) {
      expect(divider.previousElementSibling).not.toBeNull()
      expect(divider.nextElementSibling).not.toBeNull()
      expect(divider.nextElementSibling?.classList.contains("border-t")).toBe(false)
    }
  })

  it("still open their placeholder page by address", async () => {
    expect(mainText(await studioAt("/webhooks", { host }))).toContain("Webhooks")
  })
})

describe("the Settings Public values slot", () => {
  it("renders the host's PublicValues card", async () => {
    const withCard: StaticSiteHost = { ...host, PublicValues: () => <div>Public values card</div> }
    expect(mainText(await studioAt("/static-site/settings", { host: withCard }))).toContain("Public values card")
  })

  it("renders nothing without one", async () => {
    expect(mainText(await studioAt("/static-site/settings", { host }))).not.toContain("Public values")
  })
})

describe("the Overview empty state", () => {
  it("shows no site address link and tells self-host how to get a site", async () => {
    const container = await studioAt("/static-site", { host })
    const text = mainText(container)
    expect(container.querySelector("main a")).toBeNull()
    expect(text).toContain("set app in supatype.config.ts")
    expect(text).toContain("supatype dev")
    expect(text).not.toContain("supatype deploy")
  })

  it("tells Cloud to run supatype deploy", async () => {
    const cloud: StaticSiteHost = { ...host, Deployments: () => <div>d</div> }
    const text = mainText(await studioAt("/static-site", { host: cloud }))
    expect(text).toContain("Run supatype deploy to put your first version live.")
  })
})
