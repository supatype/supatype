// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `?migration=<id>` links from Schema objects: the migration they name is shown expanded, a second
 * link followed while the screen is open expands the new one, and an id that is not a tracked
 * migration says so instead of showing an empty list.
 */

const ROWS = [1, 2, 3].map((id) => ({
  id,
  name: `m${id}`,
  hash: `hash${id}`.padEnd(20, "0"),
  applied_at: `2026-10-0${id} 10:00:00+00`,
  rolled_back: false,
  rolled_back_at: null,
  engine_version: "0.7.0",
  schema_snapshot: { models: [{ name: `M${id}`, tableName: `m${id}`, fields: {} }] },
  has_sql: true,
}))

const proxy = {
  sql: vi.fn(async (query: string) => {
    if (query.includes("information_schema")) return { rows: [{ audited: false }] }
    return query.includes("ORDER BY id") ? { rows: ROWS } : { rows: [{ sql_up: "CREATE TABLE x ();" }] }
  }),
}

vi.mock("../src/hooks/useProjectProxy.js", () => ({ useProjectProxy: () => proxy }))

import { MigrationHistory } from "../src/views/MigrationHistory.js"

let container: HTMLDivElement
let root: Root
let navigate: NavigateFunction

function Navigator(): null {
  navigate = useNavigate()
  return null
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function open(url: string): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Navigator />
        <MigrationHistory />
      </MemoryRouter>,
    )
  })
}

/** The ids of the rows shown expanded (their caret points down). */
function expandedIds(): number[] {
  return Array.from(container.querySelectorAll("tbody tr"))
    .filter((row) => row.querySelector("td")?.textContent === "▾")
    .map((row) => Number(row.querySelectorAll("td")[1]?.textContent))
}

describe("a link to one migration", () => {
  it("shows that migration expanded", async () => {
    await open("/migrations?migration=2")
    expect(container.textContent).toContain("Showing migration #2 only.")
    expect(expandedIds()).toEqual([2])
  })

  it("expands the migration a second link names, while the screen stays open", async () => {
    await open("/migrations?migration=2")
    await act(async () => navigate("/migrations?migration=3"))
    expect(container.textContent).toContain("Showing migration #3 only.")
    expect(expandedIds()).toEqual([3])
  })

  it("says a linked id that is not a tracked migration was not found", async () => {
    await open("/migrations?migration=99")
    expect(container.textContent).toContain("Migration #99 not found")
    expect(container.textContent).not.toContain("No migrations match your filters")
  })
})

describe("when the migrations ledger cannot be read", () => {
  it("shows a missing column as the failure it is, not as a database with no migrations", async () => {
    proxy.sql.mockImplementationOnce(async () => {
      throw Object.assign(new Error('column "engine_version" does not exist'), { code: "42703" })
    })
    await open("/migrations")
    expect(container.textContent).toContain('column "engine_version" does not exist')
    expect(container.textContent).not.toContain("No migrations yet")
  })

  it("treats a missing ledger as no migrations yet, whatever language the message is in", async () => {
    proxy.sql.mockImplementationOnce(async () => {
      throw Object.assign(new Error("FEHLER: Relation existiert nicht"), { code: "42P01" })
    })
    await open("/migrations")
    expect(container.textContent).toContain("No migrations yet")
  })
})
