// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The Schema objects screen against a proxy: the table filter asks the database once typing
 * pauses, and only the answer to the latest question is shown however late an older one arrives.
 */

interface Pending {
  query: string
  resolve: (rows: Record<string, unknown>[]) => void
}

const pending: Pending[] = []
const proxy = {
  sql: vi.fn(
    (query: string) =>
      new Promise<{ rows: Record<string, unknown>[] }>((resolve) => {
        if (query.startsWith("SELECT DISTINCT kind")) resolve({ rows: [{ kind: "table" }] })
        else pending.push({ query, resolve: (rows) => resolve({ rows }) })
      }),
  ),
}

vi.mock("../src/hooks/useProjectProxy.js", () => ({ useProjectProxy: () => proxy }))

import { FILTER_DEBOUNCE_MS, SchemaObjects } from "../src/views/SchemaObjects.js"

const table = (name: string) => ({ kind: "table", schema_name: "public", parent: "", name, status: "managed", total: 1 })

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  pending.length = 0
  proxy.sql.mockClear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function type(value: string): Promise<void> {
  const input = container.querySelector("input")!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

/** The page queries sent so far, by the table they filter on ("" for none). */
const asked = () => pending.map((p) => /ILIKE '%(.*?)%'/.exec(p.query)?.[1] ?? "")

async function openScreen(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SchemaObjects />
      </MemoryRouter>,
    )
  })
  await act(async () => pending.shift()!.resolve([table("first")]))
  await flush()
}

describe("Schema objects against the ledger", () => {
  it("asks the database once typing in the table filter pauses", async () => {
    await openScreen()
    await type("p")
    await type("po")
    await type("pos")
    expect(asked()).toEqual([])
    await act(async () => vi.advanceTimersByTime(FILTER_DEBOUNCE_MS))
    expect(asked()).toEqual(["pos"])
  })

  it("shows the answer to the latest filter, not an older one that arrives after it", async () => {
    await openScreen()
    await type("a")
    await act(async () => vi.advanceTimersByTime(FILTER_DEBOUNCE_MS))
    await type("b")
    await act(async () => vi.advanceTimersByTime(FILTER_DEBOUNCE_MS))
    expect(asked()).toEqual(["a", "b"])
    const [older, newer] = pending
    await act(async () => newer!.resolve([table("from_b")]))
    await act(async () => older!.resolve([table("from_a")]))
    await flush()
    expect(container.textContent).toContain("from_b")
    expect(container.textContent).not.toContain("from_a")
  })
})
