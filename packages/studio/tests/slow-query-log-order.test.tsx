// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { SlowQueryLog } from "../src/components/monitoring/SlowQueryLog.js"

/**
 * The slow query log ranks on the server by the column it is sorted by. It always fetched the top
 * 50 by total time and re-sorted those in the browser, so sorting by mean or max ranked only that
 * set: a query with a high mean but a low total never appeared.
 */

let root: Root | null = null
let container: HTMLElement
let sqls: string[] = []

const row = { query_id: "1", query: "select 1", calls: 1, total_time_ms: 1, mean_time_ms: 1, max_time_ms: 1, rows: 1, time_pct: 1 }

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
})

describe("the slow query log", () => {
  it("asks the database for the top queries by the column it is sorted by", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    sqls = []
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    const run = async (sql: string) => {
      sqls.push(sql)
      return { rows: [row] }
    }
    await act(async () => root!.render(<SlowQueryLog onRunQuery={run} refreshIntervalSeconds={0} />))
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(sqls.at(-1)).toMatch(/ORDER BY total_exec_time DESC/)
    const mean = Array.from(container.querySelectorAll("th")).find((th) => th.textContent?.startsWith("Mean"))
    await act(async () => mean?.click())
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(sqls.at(-1)).toMatch(/ORDER BY mean_exec_time DESC/)
  })
})
