// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { EmailTemplatesView } from "../src/views/auth/EmailTemplatesView.js"
import { testClient } from "./support.js"

/**
 * TP1: the auth server keeps a template saved from Studio in the database and says so (`saved`,
 * `saved_at`), and `DELETE /auth/v1/admin/template/:type` goes back to the configured or default
 * template and answers with it. Studio shows which is in force, offers the reset only when there is
 * a saved edit to undo, and shows the server's own reason when a save is refused.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

const SAVED_AT = "2026-10-13T17:00:00Z"
const SAVED = { subject: "Welcome aboard", content: "<p>Saved edit</p>", saved: true, saved_at: SAVED_AT }
const DEFAULT = { subject: "Confirm your signup", content: "<p>Default</p>", saved: false }

interface Call {
  method: string
  url: string
  body: string | null
}

let root: Root | null = null
let container: HTMLElement
let calls: Call[] = []

type Answer = (call: Call) => Response

async function render(answer: Answer): Promise<void> {
  calls = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : null }
    calls.push(call)
    return answer(call)
  })
  container = document.createElement("div")
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <AdminClientContext.Provider value={CLIENT}>
        <EmailTemplatesView />
      </AdminClientContext.Provider>,
    ),
  )
  await settle()
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)
}

async function click(label: string): Promise<void> {
  const b = button(label)
  if (!b) throw new Error(`no "${label}" button`)
  await act(async () => b.click())
  await settle()
}

function fieldValues(): { subject: string; content: string } {
  const subject = container.querySelector<HTMLInputElement>("input[type=text]")?.value ?? ""
  const content = container.querySelector<HTMLTextAreaElement>("textarea")?.value ?? ""
  return { subject, content }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.unstubAllGlobals()
})

describe("a template with a saved edit", () => {
  it("says the saved edit is in force, and since when", async () => {
    await render(() => Response.json(SAVED))
    expect(container.textContent).toContain("Saved edit in force since")
    expect(container.textContent).toContain(new Date(SAVED_AT).toLocaleString())
  })

  it("resets to the default with DELETE, and shows the template the server says is now in force", async () => {
    await render((call) => Response.json(call.method === "DELETE" ? DEFAULT : SAVED))
    await click("Reset to default")
    // The saved edit is gone for good once reset, so the click only asks.
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("Reset this template to the default?")
    expect(calls.map((c) => c.method)).toEqual(["GET"])
    await click("Reset template")
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"])
    expect(calls[1]!.url).toBe("http://localhost:8000/studio/proxy/auth/v1/admin/template/confirmation")
    expect(fieldValues()).toEqual({ subject: DEFAULT.subject, content: DEFAULT.content })
    expect(container.textContent).not.toContain("Saved edit in force since")
    expect(button("Reset to default")).toBeUndefined()
  })
})

describe("a template with no saved edit", () => {
  it("offers no reset and claims no saved edit", async () => {
    await render(() => Response.json(DEFAULT))
    expect(button("Reset to default")).toBeUndefined()
    expect(container.textContent).not.toContain("Saved edit in force since")
  })
})

describe("saving", () => {
  it("shows the saved edit as in force once the server keeps it", async () => {
    await render((call) =>
      call.method === "PUT" ? Response.json({ ...DEFAULT, saved: true, saved_at: SAVED_AT }) : Response.json(DEFAULT),
    )
    await click("Save template")
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"])
    expect(container.textContent).toContain("Saved edit in force since")
    expect(button("Reset to default")).toBeDefined()
  })

  it("shows the server's reason when it refuses the save", async () => {
    const msg = "A saved template needs a subject and a body"
    await render((call) =>
      call.method === "PUT"
        ? Response.json({ code: 400, error_code: "validation_failed", msg }, { status: 400 })
        : Response.json(DEFAULT),
    )
    await click("Save template")
    expect(container.textContent).toContain(msg)
    expect(container.textContent).not.toContain("Saved edit in force since")
  })
})
