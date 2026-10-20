// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { StudioCore } from "../src/StudioCore.js"
import { testClient, testConfig, testModel } from "./support.js"

/**
 * Studio's chrome at phone width: the burger's primary menu, the section panel and its toggle,
 * the header and search. jsdom applies no media queries, so what a phone sees is read from the
 * elements and their responsive classes, and the overlays are driven by clicking.
 */

const CONFIG = testConfig({ models: [testModel({ name: "page", label: "Page", labelPlural: "Pages" })] })
const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

let root: Root | null = null
let container: HTMLElement

async function studioAt(path: string): Promise<void> {
  vi.stubGlobal("fetch", async () => new Promise<Response>(() => {}))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <StudioCore config={CONFIG} client={CLIENT} />
      </MemoryRouter>,
    ),
  )
  for (let i = 0; i < 5; i++) await act(async () => {})
}

function byLabel(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}

async function click(label: string): Promise<void> {
  const el = byLabel(label)
  if (el === null) throw new Error(`no element labelled ${label}`)
  await act(async () => el.click())
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container.remove()
  vi.unstubAllGlobals()
})

describe("the section panel toggle", () => {
  it.each(["/", "/webhooks", "/email"])("is absent on %s, which has no section panel to open", async (path) => {
    await studioAt(path)
    expect(byLabel("Toggle section navigation")).toBeNull()
  })

  it.each(["/media-storage", "/database/overview", "/settings", "/models/page"])("is offered on %s, whose section has one", async (path) => {
    await studioAt(path)
    expect(byLabel("Toggle section navigation")).not.toBeNull()
  })
})
