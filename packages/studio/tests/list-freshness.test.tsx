// @vitest-environment jsdom
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { button, renderBrowser } from "./data-browser-support.js"
import { renderList } from "./list-view-support.js"
import { isolateEachTest, settle, testModel } from "./support.js"

/**
 * Lists fetched once when their filter, sort or page changed and never again, so a row added
 * elsewhere stayed invisible until the user changed something. They now have a Refresh button,
 * refetch when the user comes back to a stale tab, and offer an auto-refresh that does not spend
 * requests on a hidden tab.
 */

isolateEachTest("setInterval", "clearInterval", "Date")

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  setVisibility("visible")
})

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
}

async function chooseAutoRefresh(container: HTMLElement, ms: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>("select[aria-label='Auto-refresh']")
  if (!select) throw new Error("no auto-refresh menu")
  await act(async () => {
    select.value = ms
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}

async function pass(ms: number): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(ms) })
  await settle()
}

async function fire(target: EventTarget, type: string): Promise<void> {
  await act(async () => { target.dispatchEvent(new Event(type)) })
  await settle()
}

describe("the Refresh button", () => {
  it("fetches a model's list again", async () => {
    const list = await renderList(testModel())
    const before = list.reads.length
    await act(async () => button(list.container, "Refresh").click())
    await settle()
    expect(list.reads.length).toBe(before + 1)
  })

  it("fetches the data browser's rows again", async () => {
    const browser = await renderBrowser()
    const before = browser.reads.length
    await act(async () => button(browser.container, "Refresh").click())
    await settle()
    expect(browser.reads.length).toBe(before + 1)
  })
})

describe("coming back to the tab", () => {
  it("refetches a list older than a minute and leaves a fresh one alone", async () => {
    const list = await renderList(testModel())
    const before = list.reads.length
    await pass(30_000)
    await fire(window, "focus")
    expect(list.reads.length).toBe(before)
    await pass(31_000)
    await fire(window, "focus")
    expect(list.reads.length).toBe(before + 1)
  })
})

describe("auto-refresh", () => {
  it("refetches on its period and not while the tab is hidden", async () => {
    const list = await renderList(testModel())
    await chooseAutoRefresh(list.container, "10000")
    const before = list.reads.length
    await pass(10_000)
    expect(list.reads.length).toBe(before + 1)

    setVisibility("hidden")
    await pass(30_000)
    expect(list.reads.length).toBe(before + 1)

    setVisibility("visible")
    await fire(document, "visibilitychange")
    expect(list.reads.length).toBe(before + 2)
  })

  it("is remembered for each list", async () => {
    const first = await renderList(testModel())
    await chooseAutoRefresh(first.container, "30000")
    first.unmount()
    const again = await renderList(testModel())
    const select = again.container.querySelector<HTMLSelectElement>("select[aria-label='Auto-refresh']")
    expect(select?.value).toBe("30000")
    const other = testModel({ name: "page", tableName: "page" })
    again.unmount()
    const otherList = await renderList(other)
    expect(otherList.container.querySelector<HTMLSelectElement>("select[aria-label='Auto-refresh']")?.value).toBe("off")
  })

  it("holds off while a cell in the data browser is being edited", async () => {
    const browser = await renderBrowser()
    await chooseAutoRefresh(browser.container, "10000")
    const cell = browser.container.querySelector("tbody td:nth-child(3)")
    if (!cell) throw new Error("no body cell")
    await act(async () => { cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })) })
    const before = browser.reads.length
    await pass(30_000)
    expect(browser.reads.length).toBe(before)
  })
})
