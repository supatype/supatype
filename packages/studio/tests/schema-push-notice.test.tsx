// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The schema push notice: while the newest push the database recorded was refused or failed, and
 * no push has applied since, every screen says the live schema is unchanged, how to apply the
 * change, and where its record is. Nothing at all otherwise, and nothing when the history cannot
 * be read (a server from before the query, a role without schema view, no history yet).
 */

const status = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, fails: false }))

const proxy = {
  metadata: vi.fn(async (name: string) => {
    if (name !== "schema_push_status") throw new Error(`unexpected query ${name}`)
    if (status.fails) throw new Error("Unknown metadata query: schema_push_status")
    return { rows: status.row === null ? [] : [status.row] }
  }),
}

vi.mock("../src/hooks/useProjectProxy.js", () => ({ useProjectProxy: () => proxy }))

/** The caller the server reported: a developer, who holds schema view, unless a test says otherwise. */
const DEVELOPER = { role: "developer", permissions: { read: true, write: true, schemaView: true }, settled: true }
const access = vi.hoisted(() => ({
  current: { role: null, permissions: {}, settled: false } as {
    role: string | null
    permissions: Record<string, boolean>
    settled: boolean
  },
}))

vi.mock("../src/hooks/useStudioCapability.js", () => ({
  useStudioCapability: () => ({
    userId: null,
    mode: "studio",
    canElevate: false,
    canManageMembers: false,
    seesDrafts: false,
    identityLink: null,
    ...access.current,
  }),
}))

import { SchemaPushNotice } from "../src/components/SchemaPushNotice.js"
import { PENDING_PUSH_IDLE_POLL_MS, PENDING_PUSH_POLL_MS } from "../src/hooks/usePendingSchemaPush.js"

/** What `document.visibilityState` reports, as a tab sent to the background or brought back. */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
}

const REFUSED = {
  id: 7,
  name: "refused_0123456789abcdef",
  applied_at: "2026-10-17 12:00:00+00",
  status: "refused",
  error_message: "3 destructive operation(s) detected. Use --force to proceed.",
  operations: ["drop_column site.tagline", "drop_column site.motto", "drop_column site.hero"],
  hints: ["supatype rename site.tagline site.strapline", "supatype push --yes"],
  superseded_at: null,
}

let container: HTMLDivElement
let root: Root

function Where(): React.ReactElement {
  const location = useLocation()
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  status.row = null
  status.fails = false
  access.current = DEVELOPER
  proxy.metadata.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/models"]}>
        <SchemaPushNotice />
        <Where />
      </MemoryRouter>,
    )
  })
}

function where(): string {
  return container.querySelector("[data-testid=where]")?.textContent ?? ""
}

describe("a refused push", () => {
  it("says the live schema is unchanged, what was refused and how to apply it", async () => {
    status.row = REFUSED
    await render()
    const text = container.textContent ?? ""
    expect(text).toContain("Schema push refused")
    expect(text).toContain("The database is still on the schema from the last push that applied")
    expect(text).toContain("3 destructive operation(s) detected.")
    expect(text).toContain("drop_column site.tagline")
    expect(text).toContain("supatype rename site.tagline site.strapline")
    expect(text).toContain("supatype push --yes")
    expect(text).toContain("clears once a push applies")
  })

  it("links to its record in Migration History", async () => {
    status.row = REFUSED
    await render()
    const open = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "View in Migration History")
    await act(async () => open?.click())
    expect(where()).toBe("/database/migrations?migration=7")
  })
})

describe("a push that fixes the schema", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("clears the notice within seconds, with no navigation", async () => {
    // It was asked again only on navigation, so it stayed up for as long as nobody clicked.
    vi.useFakeTimers()
    status.row = REFUSED
    await render()
    expect(container.textContent).toContain("Schema push refused")
    status.row = { ...REFUSED, superseded_at: "2026-10-17 12:05:00+00" }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_PUSH_POLL_MS)
    })
    expect(container.textContent).toBe("/models")
  })

  it("slows to the idle pace once nothing is pending", async () => {
    vi.useFakeTimers()
    await render()
    const asked = proxy.metadata.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_PUSH_POLL_MS * 3)
    })
    expect(proxy.metadata.mock.calls.length).toBe(asked)
  })
})

describe("a push refused while the screen is open", () => {
  afterEach(() => {
    vi.useRealTimers()
    setVisibility("visible")
  })

  it("appears within the idle pace, with no navigation", async () => {
    // It was asked only on navigation, so a refusal stayed unsaid on the screen in front of you.
    vi.useFakeTimers()
    await render()
    status.row = REFUSED
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_PUSH_IDLE_POLL_MS)
    })
    expect(container.textContent).toContain("Schema push refused")
  })

  it("appears as soon as the tab is back", async () => {
    await render()
    status.row = REFUSED
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.textContent).toContain("Schema push refused")
  })

  it("is not asked for while the tab is in the background", async () => {
    vi.useFakeTimers()
    await render()
    setVisibility("hidden")
    const asked = proxy.metadata.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_PUSH_IDLE_POLL_MS * 2)
    })
    expect(proxy.metadata.mock.calls.length).toBe(asked)
  })
})

describe("a failed push", () => {
  it("is said the same way", async () => {
    status.row = { ...REFUSED, status: "failed", error_message: "Failed to apply migration", operations: null, hints: null }
    await render()
    expect(container.textContent).toContain("Schema push failed")
    expect(container.textContent).toContain("Failed to apply migration")
  })
})

describe("nothing is shown", () => {
  it("when the newest push applied", async () => {
    status.row = { ...REFUSED, status: "applied", error_message: null }
    await render()
    expect(container.textContent).toBe("/models")
  })

  it("when a push has applied since the refusal", async () => {
    status.row = { ...REFUSED, superseded_at: "2026-10-17 12:05:00+00" }
    await render()
    expect(container.textContent).toBe("/models")
  })

  it("when there is no history", async () => {
    await render()
    expect(container.textContent).toBe("/models")
  })

  it("when the server cannot answer the query", async () => {
    status.row = REFUSED
    status.fails = true
    await render()
    expect(container.textContent).toBe("/models")
  })
})

describe("who is asked", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Render, let the idle timer fire twice and the tab come back, and count the status requests. */
  async function requestsOverAMinute(): Promise<number> {
    vi.useFakeTimers()
    await render()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_PUSH_IDLE_POLL_MS * 2)
      document.dispatchEvent(new Event("visibilitychange"))
    })
    return proxy.metadata.mock.calls.length
  }

  it("never asks for a role the server refuses the catalogue to", async () => {
    // An editor holds no schema view, so every request was a 403, on each page and each half minute.
    access.current = { role: "editor", permissions: { read: true, write: true, schemaView: false }, settled: true }
    status.row = REFUSED
    expect(await requestsOverAMinute()).toBe(0)
    expect(container.textContent).toBe("/models")
  })

  it("does not ask before the server has said who the caller is", async () => {
    access.current = { role: null, permissions: {}, settled: false }
    expect(await requestsOverAMinute()).toBe(0)
  })

  it("asks for a viewer, who holds schema view", async () => {
    access.current = { role: "viewer", permissions: { read: true, schemaView: true }, settled: true }
    expect(await requestsOverAMinute()).toBeGreaterThan(0)
  })

  it("asks when the server answered without saying, as every other gate does", async () => {
    access.current = { role: null, permissions: {}, settled: true }
    expect(await requestsOverAMinute()).toBeGreaterThan(0)
  })
})
