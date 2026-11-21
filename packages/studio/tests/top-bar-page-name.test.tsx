// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { TopBar } from "../src/components/TopBar.js"
import { testConfig } from "./support.js"

// The bar's search, account menu, locale switcher and connect dialog need app providers that
// say nothing about the breadcrumb, so they stand down here.
vi.mock("../src/components/JumpToSearch.js", () => ({ JumpToSearch: () => null, JumpToSearchSheet: () => null }))
vi.mock("../src/components/UserAccountMenu.js", () => ({ UserAccountMenu: () => null }))
vi.mock("../src/components/LocaleSwitcher.js", () => ({ LocaleSwitcher: () => null }))
vi.mock("../src/components/ConnectModal.js", () => ({ ConnectModal: () => null }))

/**
 * Finding S-2: the header named only the host ("Studio / Main", or Cloud's org / project /
 * environment), so the page you were on showed only in the side panel and the tab title. The header
 * now appends the current page's breadcrumb after whatever the host gives.
 */

const SIDEBAR = { open: false, onToggle: () => undefined, controls: "menu" }
let root: Root | null = null
let container: HTMLElement

function HostCrumb(): React.ReactElement {
  return <span>Acme</span>
}

async function render(path: string, leftItems?: React.ComponentType[]): Promise<HTMLElement> {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <TopBar config={testConfig()} {...(leftItems !== undefined && { leftItems })} sidebar={SIDEBAR} />
      </MemoryRouter>,
    )
  })
  const header = container.querySelector("header")
  if (header === null) throw new Error("no header")
  return header
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe("the header names the current page", () => {
  it("shows a rail page after Studio", async () => {
    const header = await render("/webhooks")
    expect(header.textContent).toContain("Studio")
    expect(header.textContent).toContain("Webhooks")
  })

  it("shows every segment of a nested page", async () => {
    const header = await render("/observability/logs/auth")
    for (const part of ["Observability", "Logs", "Auth"]) expect(header.textContent).toContain(part)
  })

  it("says nothing extra for a page with no title entry", async () => {
    const header = await render("/nowhere")
    expect(header.textContent?.match(/Studio/g)).toHaveLength(1)
  })

  it("appends after the host's own segments without the host doing anything", async () => {
    const header = await render("/jobs", [HostCrumb])
    const text = header.textContent ?? ""
    expect(text).toContain("Acme")
    expect(text.indexOf("Scheduled Jobs")).toBeGreaterThan(text.indexOf("Acme"))
  })
})
