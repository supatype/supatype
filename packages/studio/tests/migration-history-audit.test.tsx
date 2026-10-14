// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The audit trail in Studio's migration history: who pushed each migration (verified only when a
 * control plane authenticated them), through what and from where, and each rename it applied with
 * who declared it. A history from before the audit columns names the manifest's author, unverified.
 */

const base = {
  hash: "hash".padEnd(20, "0"),
  rolled_back: false,
  rolled_back_at: null,
  engine_version: "0.7.0",
  has_sql: true,
}

const ROWS = [
  {
    ...base,
    id: 1,
    name: "m1",
    applied_at: "2026-10-01 10:00:00+00",
    schema_snapshot: { models: [{ name: "member", tableName: "member", fields: { name: { kind: "text", pgType: "TEXT" } } }] },
    manifest_pushed_by: "nic",
  },
  {
    ...base,
    id: 2,
    name: "m2",
    applied_at: "2026-10-02 10:00:00+00",
    schema_snapshot: { models: [{ name: "member", tableName: "member", fields: { title: { kind: "text", pgType: "TEXT" } } }] },
    pushed_by: "service_role",
    pushed_by_verified: "true",
    pushed_via: "self-host",
    pushed_from: "ci https://ci.example/run/7",
    renames: [
      { kind: "column", table: "member", from: "name", to: "title", declared_by: "Ada <ada@example.com>", declared_at: "2026-10-02T09:00:00Z" },
    ],
  },
]

const proxy = {
  metadata: vi.fn(async (name: string) => {
    if (name === "migrations_audited") return { rows: [{ audited: true }] }
    return name === "migrations" ? { rows: ROWS } : { rows: [{ sql_up: "ALTER TABLE x;" }] }
  }),
}

vi.mock("../src/hooks/useProjectProxy.js", () => ({ useProjectProxy: () => proxy }))

import { MigrationHistory, migrationsQuery } from "../src/views/MigrationHistory.js"

let container: HTMLDivElement
let root: Root

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
        <MigrationHistory />
      </MemoryRouter>,
    )
  })
}

describe("the migration history's audit trail", () => {
  it("reads the audit columns where the history has them, and the legacy shape where it does not", async () => {
    await open("/migrations")
    const asked = proxy.metadata.mock.calls.map(([name]) => name)
    expect(asked).toEqual(expect.arrayContaining(["migrations_audited", "migrations"]))
    expect(migrationsQuery(true)).toBe("migrations")
    expect(migrationsQuery(false)).toBe("migrations_legacy")
  })

  it("names each author, verified only where a control plane said so", async () => {
    await open("/migrations")
    const rows = Array.from(container.querySelectorAll("tbody tr")).map((row) => row.textContent ?? "")
    expect(rows.find((r) => r.includes("m2"))).toContain("service_roleverified")
    expect(rows.find((r) => r.includes("m1"))).toContain("nicunverified")
  })

  it("shows the channel, the origin and each rename with who declared it", async () => {
    await open("/migrations?migration=2")
    const text = container.textContent ?? ""
    expect(text).toContain("self-host")
    expect(text).toContain("ci https://ci.example/run/7")
    expect(text).toContain("member.name -> title")
    expect(text).toContain("declared by Ada <ada@example.com>")
  })
})
