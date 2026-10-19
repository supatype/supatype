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

import { SchemaPushNotice } from "../src/components/SchemaPushNotice.js"
import { PENDING_PUSH_POLL_MS } from "../src/hooks/usePendingSchemaPush.js"

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

  it("stops asking once nothing is pending", async () => {
    vi.useFakeTimers()
    await render()
    const asked = proxy.metadata.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_PUSH_POLL_MS * 3)
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
