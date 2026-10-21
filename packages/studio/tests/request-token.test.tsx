// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiDocs } from "../src/views/ApiDocs.js"
import { ModelApiDocs } from "../src/views/ModelApiDocs.js"
import { InvokeTab } from "../src/views/EdgeFunctions.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * Studio's request builders (the REST explorer, a model's API page, Invoke on an edge function)
 * started with no token, so the first request went out anonymous and was refused, and the editor
 * had to find a token somewhere to paste in. Each now starts from the signed-in Studio user's own
 * access token, sent as a Bearer header.
 */

const TOKEN = "studio-user-jwt"
const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: TOKEN })
const MODEL = testModel({ name: "speaker", tableName: "speaker", fields: [testField({ name: "name" })] })

let sent: Headers[] = []
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  sent = []
  vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
    sent.push(new Headers(init?.headers))
    return Response.json([])
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(view: React.ReactElement): Promise<void> {
  await act(async () =>
    root.render(
      <AdminConfigContext.Provider value={testConfig({ models: [MODEL] })}>
        <AdminClientContext.Provider value={CLIENT}>{view}</AdminClientContext.Provider>
      </AdminConfigContext.Provider>,
    ),
  )
}

async function click(pattern: RegExp): Promise<void> {
  const target = [...container.querySelectorAll("button")].find((b) => pattern.test((b.textContent ?? "").trim()))
  if (target === undefined) throw new Error(`no button ${String(pattern)} in: ${container.textContent ?? ""}`)
  await act(async () => { target.click() })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

/** The send-as choice the panel starts on. */
function sendAs(): HTMLSelectElement {
  const select = container.querySelector('select[aria-label="Send as"]')
  if (!(select instanceof HTMLSelectElement)) throw new Error("no send-as choice")
  return select
}

/** The token input "A token I paste" opens, which starts as the signed-in user's own. */
async function pastedTokenInput(): Promise<HTMLInputElement> {
  const select = sendAs()
  await act(async () => {
    select.value = "token"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  const input = container.querySelector('input[aria-label="Bearer token"]')
  if (!(input instanceof HTMLInputElement)) throw new Error("no token input")
  return input
}

describe("a request builder's token", () => {
  it("starts as the signed-in user's on a model's API page, and is sent", async () => {
    await render(<ModelApiDocs model={MODEL} />)
    await click(/^Try It$/)
    expect(sendAs().value).toBe("me")
    await click(/^Send GET Request$/)
    expect(sent.at(-1)?.get("Authorization")).toBe(`Bearer ${TOKEN}`)
  })

  it("starts as the signed-in user's in the REST explorer", async () => {
    await render(<ApiDocs />)
    const expand = [...container.querySelectorAll("div.cursor-pointer")].find((el) => (el.textContent ?? "").includes("/rest/v1/speaker"))
    if (!(expand instanceof HTMLElement)) throw new Error("no endpoint")
    await act(async () => { expand.click() })
    await click(/^Try It$/)
    expect(sendAs().value).toBe("me")
    expect((await pastedTokenInput()).value).toBe(TOKEN)
  })

  it("invokes an edge function as the signed-in user unless told otherwise", async () => {
    await render(<InvokeTab functionName="hello" clientUrl="http://localhost:8000" />)
    await click(/^Invoke$/)
    expect(sent.at(-1)?.get("Authorization")).toBe(`Bearer ${TOKEN}`)
  })
})
