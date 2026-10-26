// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Migration History shows what each push did: applied, failed, refused or rolled back. It derived
 * the status from `rolled_back` alone, so a push that failed mid-apply read as applied, and one the
 * engine refused before applying anything (recorded with no `sql_up`) was not listed at all.
 */

const base = {
  hash: "hash".padEnd(20, "0"),
  rolled_back: false,
  rolled_back_at: null,
  engine_version: "0.8.0",
}
const SNAPSHOT = { models: [{ name: "Tag", tableName: "tags", fields: { name: { pgType: "TEXT" } } }] }

const ROWS = [
  { ...base, id: 1, name: "push_1", applied_at: "2026-10-01 10:00:00+00", has_sql: true, schema_snapshot: SNAPSHOT, status: "applied" },
  {
    ...base,
    id: 2,
    name: "push_2",
    applied_at: "2026-10-02 10:00:00+00",
    has_sql: true,
    schema_snapshot: null,
    status: "failed",
    error_message: "Failed to apply migration: check constraint violated",
  },
  {
    ...base,
    id: 3,
    name: "refused_0123456789abcdef",
    applied_at: "2026-10-03 10:00:00+00",
    has_sql: false,
    schema_snapshot: null,
    status: "refused",
    error_message: "1 destructive operation(s) detected. Use --force to proceed.",
    refusal: {
      reason: "destructive",
      sql: 'ALTER TABLE "public"."tags" DROP COLUMN "name";',
      operations: ["drop_column tags.name"],
      hints: ["supatype push --yes"],
    },
    superseded_at: null,
  },
]

const proxy = {
  metadata: vi.fn(async (name: string) => {
    if (name === "migrations_audited") return { rows: [{ audited: true }] }
    return name === "migrations" ? { rows: ROWS } : { rows: [{ sql_up: "ALTER TABLE x;" }] }
  }),
}

vi.mock("../src/hooks/useProjectProxy.js", () => ({ useProjectProxy: () => proxy }))

import { MigrationHistory } from "../src/views/MigrationHistory.js"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
        <MigrationHistory />
      </MemoryRouter>,
    )
  })
}

/** Each listed migration's id and the status its badge shows. */
function statuses(): Array<[number, string]> {
  return Array.from(container.querySelectorAll("tbody tr"))
    .filter((row) => row.querySelectorAll("td").length > 3)
    .map((row) => {
      const cells = row.querySelectorAll("td")
      return [Number(cells[1]?.textContent), cells[3]?.textContent ?? ""]
    })
}

describe("each migration's status", () => {
  it("is the one the engine recorded, refused pushes included", async () => {
    await open("/migrations")
    expect(statuses()).toEqual([
      [3, "refused"],
      [2, "failed"],
      [1, "applied"],
    ])
  })

  it("can be filtered on", async () => {
    await open("/migrations")
    const select = container.querySelector("select")
    expect(Array.from(select?.options ?? []).map((o) => o.value)).toEqual([
      "all",
      "applied",
      "failed",
      "refused",
      "rolled_back",
    ])
  })
})

describe("a refused push, opened", () => {
  it("says why it was refused, what it would drop and how to apply it, with its statements", async () => {
    await open("/migrations?migration=3")
    const text = container.textContent ?? ""
    expect(text).toContain("1 destructive operation(s) detected.")
    expect(text).toContain("drop_column tags.name")
    expect(text).toContain("supatype push --yes")
    expect(text).toContain('DROP COLUMN "name"')
    expect(text).toContain("Nothing was applied")
  })
})

describe("a failed push, opened", () => {
  it("says why it failed", async () => {
    await open("/migrations?migration=2")
    expect(container.textContent).toContain("Failed to apply migration: check constraint violated")
  })
})
