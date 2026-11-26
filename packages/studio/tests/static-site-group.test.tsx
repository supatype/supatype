// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { StudioCore } from "../src/StudioCore.js"
import { buildStaticSiteSection } from "../src/components/SecondaryPanel.js"
import { selfHostStaticSite, siteAddress } from "../src/lib/self-host-static-site.js"
import type { HostRead, StaticSiteHost, StaticSiteOverview, StaticSiteSettings } from "../src/lib/static-site-host.js"
import { isolateEachTest, mount, settle, testClient, testConfig } from "./support.js"

/**
 * The Static site group: one set of shared pages that read through a host, so self-host and Cloud
 * get the same Overview and Settings, and only Cloud's host adds Deployments.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

/** A server that signs the caller in as an admin and leaves every other request pending. */
function backend(url: string): Promise<Response> {
  if (url.endsWith("/studio/auth/verify")) {
    return Promise.resolve(Response.json({ role: "admin", sub: "u1", permissions: { administer: true } }))
  }
  return new Promise<Response>(() => {})
}

function read<T>(data: T): HostRead<T> {
  return { data, loading: false, error: null }
}

const SELF_HOST_OVERVIEW: StaticSiteOverview = {
  address: "http://localhost:8000",
  mode: "static",
  staticDir: "/srv/app/dist",
  upstream: null,
  serving: true,
  fileCount: 12,
  totalBytes: 2048,
}

const SELF_HOST_SETTINGS: StaticSiteSettings = {
  mode: "static",
  spaFallback: true,
  headers: [{ name: "Cache-Control", value: "no-cache", appliesTo: "HTML pages" }],
  fromConfig: ["mode", "spaFallback"],
}

const selfHost: StaticSiteHost = {
  useOverview: () => read(SELF_HOST_OVERVIEW),
  useSettings: () => read(SELF_HOST_SETTINGS),
}

function CloudDeployments(): React.ReactElement {
  return <div>Deployment history and rollback</div>
}

const cloud: StaticSiteHost = {
  useOverview: () =>
    read<StaticSiteOverview>({
      address: "https://abc123.supatype.app",
      mode: "static",
      staticDir: null,
      upstream: null,
      serving: true,
      fileCount: 40,
      totalBytes: 6_000_000,
      live: { version: "v7", deployedAt: "2026-11-01T10:00:00Z", sizeBytes: 6_000_000, planBytes: 5_000_000, overPlan: true },
    }),
  useSettings: () => read<StaticSiteSettings>({ ...SELF_HOST_SETTINGS, fromConfig: ["spaFallback"], customDomainsPath: "/cloud/domains" }),
  Deployments: CloudDeployments,
}

isolateEachTest()

async function studioAt(path: string, host: StaticSiteHost | undefined): Promise<HTMLElement> {
  vi.stubGlobal("fetch", backend)
  const { container } = await mount(
    <MemoryRouter initialEntries={[path]}>
      <StudioCore config={testConfig()} client={CLIENT} {...(host !== undefined && { staticSite: host })} />
    </MemoryRouter>,
  )
  await settle()
  return container
}

function railLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('aside[aria-label="Studio navigation"] button'))
    .map((b) => b.getAttribute("aria-label") ?? "")
    .filter((label) => label !== "")
}

function mainText(container: HTMLElement): string {
  return container.querySelector("main")?.textContent ?? ""
}

describe("the group in the core rail", () => {
  it("sits beside Edge Functions", async () => {
    const labels = railLabels(await studioAt("/", selfHost))
    expect(labels.indexOf("Static site")).toBe(labels.indexOf("Edge Functions") + 1)
  })

  it("is not in the rail when the host gave Studio no Static site host", async () => {
    expect(railLabels(await studioAt("/", undefined))).not.toContain("Static site")
  })
})

describe("the group's pages", () => {
  it("has Overview and Settings on self-host, and Deployments on Cloud only", () => {
    expect(buildStaticSiteSection(selfHost).groups[0]?.items.map((i) => i.label)).toEqual(["Overview", "Settings"])
    expect(buildStaticSiteSection(cloud).groups[0]?.items.map((i) => i.label)).toEqual(["Overview", "Deployments", "Settings"])
  })

  it("answers /static-site/deployments on Cloud and not on self-host", async () => {
    expect(mainText(await studioAt("/static-site/deployments", cloud))).toContain("Deployment history and rollback")
    expect(mainText(await studioAt("/static-site/deployments", selfHost))).toContain("Page not found")
  })
})

describe("the Overview", () => {
  it("shows self-host's address, mode, directory, file count, size and whether it is serving", async () => {
    const text = mainText(await studioAt("/static-site", selfHost))
    expect(text).toContain("http://localhost:8000")
    expect(text).toContain("Static files")
    expect(text).toContain("/srv/app/dist")
    expect(text).toContain("12")
    expect(text).toContain("2.0 KB")
    expect(text).toContain("Serving")
    expect(text).not.toContain("Live version")
  })

  it("adds Cloud's live version, size against the plan with the over-plan badge, and the last deploy", async () => {
    const text = mainText(await studioAt("/static-site", cloud))
    expect(text).toContain("https://abc123.supatype.app")
    expect(text).toContain("v7")
    expect(text).toContain("5.7 MB of 4.8 MB (120%)")
    expect(text).toContain("Over plan")
    expect(text).toContain("Last deploy")
  })

  it("names the upstream for a proxy, and counts no files", async () => {
    const proxy: StaticSiteHost = {
      ...selfHost,
      useOverview: () => read<StaticSiteOverview>({ ...SELF_HOST_OVERVIEW, mode: "proxy", staticDir: null, upstream: "http://localhost:5173", fileCount: null, totalBytes: null }),
    }
    const text = mainText(await studioAt("/static-site", proxy))
    expect(text).toContain("Proxy to another server")
    expect(text).toContain("http://localhost:5173")
    expect(text).not.toContain("Total size")
  })

  it("says nothing is served for mode none", async () => {
    const none: StaticSiteHost = {
      ...selfHost,
      useOverview: () => read<StaticSiteOverview>({ ...SELF_HOST_OVERVIEW, mode: "none", address: null, staticDir: null, serving: false, fileCount: null, totalBytes: null }),
    }
    expect(mainText(await studioAt("/static-site", none))).toContain("No site is being served")
  })
})

describe("the Settings", () => {
  it("shows values set in supatype.config.ts read-only and marked as the config's", async () => {
    const container = await studioAt("/static-site/settings", selfHost)
    const text = mainText(container)
    expect(text).toContain("Set in supatype.config.ts")
    expect(text).toContain("Cache-Control: no-cache")
    // Read-only: no field or button to change a value.
    expect(container.querySelector("main input, main select, main textarea, main button")).toBeNull()
  })

  it("marks only the settings the config sets", async () => {
    const text = mainText(await studioAt("/static-site/settings", cloud))
    expect(text.match(/Set in supatype\.config\.ts/g)?.length).toBe(1)
    expect(text).toContain("Default")
  })

  it("keeps the custom domains link hidden even where the host offers it", async () => {
    const container = await studioAt("/static-site/settings", cloud)
    expect(mainText(container)).not.toContain("Custom domains")
    expect(container.querySelector('main a[href="/cloud/domains"]')).toBeNull()
  })
})

describe("the section panel", () => {
  /** The panel items marked as the current page, by their text. */
  function currentItems(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("button[aria-current=page]"))
      .map((b) => b.textContent ?? "")
      .filter((text) => ["Overview", "Deployments", "Settings"].includes(text))
  }

  it("marks only Settings on the settings page, not Overview whose address is its prefix", async () => {
    expect(currentItems(await studioAt("/static-site/settings", cloud))).toEqual(["Settings"])
  })

  it("marks only Deployments on the deployments page", async () => {
    expect(currentItems(await studioAt("/static-site/deployments", cloud))).toEqual(["Deployments"])
  })

  it("marks Overview on the overview page", async () => {
    expect(currentItems(await studioAt("/static-site", cloud))).toEqual(["Overview"])
  })
})

describe("self-host's site address", () => {
  it("is the gateway's origin, whether Studio reaches it directly or through its proxy path", () => {
    expect(siteAddress("http://localhost:8000/studio/proxy", "http://localhost:3000")).toBe("http://localhost:8000")
    expect(siteAddress("/studio/proxy", "https://app.example.com")).toBe("https://app.example.com")
  })
})

describe("a self-host gateway with no site status route", () => {
  const SITE_STATUS = {
    mode: "static",
    static_dir: "/srv/app/dist",
    spa_fallback: true,
    serving: true,
    file_count: 3,
    total_bytes: 10,
  }

  /** Signs in as an admin and answers the site status route with `status`. */
  function gateway(status: number): (url: string) => Promise<Response> {
    return (url) => {
      if (url.endsWith("/studio/auth/verify")) {
        return Promise.resolve(Response.json({ role: "admin", sub: "u1", permissions: { administer: true } }))
      }
      if (url.endsWith("/admin/v1/site/status")) {
        return Promise.resolve(status === 200 ? Response.json(SITE_STATUS) : Response.json({ error: "not_found" }, { status }))
      }
      return new Promise<Response>(() => {})
    }
  }

  async function selfHostAt(path: string, status: number): Promise<HTMLElement> {
    vi.stubGlobal("fetch", gateway(status))
    const { container } = await mount(
      <MemoryRouter initialEntries={[path]}>
        <StudioCore config={testConfig()} client={CLIENT} staticSite={selfHostStaticSite} />
      </MemoryRouter>,
    )
    await settle()
    return container
  }

  it("hides the group when the status route answers 404", async () => {
    expect(railLabels(await selfHostAt("/", 404))).not.toContain("Static site")
  })

  it("sends a visit to the group's address home when the route answers 404", async () => {
    expect(mainText(await selfHostAt("/static-site", 404))).not.toContain("Static files")
  })

  it("keeps the group when the status route answers", async () => {
    expect(railLabels(await selfHostAt("/", 200))).toContain("Static site")
  })

  it("keeps the group when the route refuses the caller, so the page can say why", async () => {
    expect(railLabels(await selfHostAt("/", 401))).toContain("Static site")
  })
})
