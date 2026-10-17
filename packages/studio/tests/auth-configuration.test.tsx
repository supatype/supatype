// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { PlatformCtx, type PlatformContext } from "../src/hooks/usePlatform.js"
import { ConfigurationView } from "../src/views/auth/ConfigurationView.js"
import { testClient } from "./support.js"

/**
 * SA1: the auth Configuration page offered a Save button that sent nothing and said "Saved".
 * No host has a route that changes these settings: self-host reads them from its environment at
 * start-up, and Cloud manages them. The page now shows what the auth server reports, and where each
 * value is set, and offers nothing it cannot do.
 */

const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined }
const CLOUD: PlatformContext = { platformUrl: "https://api.example.test/api/v1", projectRef: "abc123" }
const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

const SETTINGS = {
  external: { email: true, phone: false, github: true, google: false, anonymous_users: false },
  disable_signup: true,
  mailer_autoconfirm: false,
  phone_autoconfirm: false,
  sms_provider: "",
  saml_enabled: false,
  passkeys_enabled: false,
}

let root: Root | null = null
let container: HTMLElement
let requested: string[] = []

async function render(platform: PlatformContext, answer: () => Response): Promise<void> {
  requested = []
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url)
    return answer()
  })
  container = document.createElement("div")
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <PlatformCtx.Provider value={platform}>
        <AdminClientContext.Provider value={CLIENT}>
          <ConfigurationView />
        </AdminClientContext.Provider>
      </PlatformCtx.Provider>,
    ),
  )
  for (let i = 0; i < 5; i++) await act(async () => {})
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.unstubAllGlobals()
})

describe("the auth Configuration page", () => {
  it("shows what the auth server reports, read through the admin client", async () => {
    await render(SELF_HOST, () => Response.json(SETTINGS))
    expect(requested).toEqual(["http://localhost:8000/studio/proxy/auth/v1/settings"])
    const text = container.textContent ?? ""
    expect(text).toContain("New signups")
    expect(text).toContain("Disabled")
    expect(text).toContain("github")
  })

  it("offers no Save button, since no host can change these from Studio", async () => {
    await render(SELF_HOST, () => Response.json(SETTINGS))
    expect(container.textContent).not.toContain("Save configuration")
    expect(container.querySelector("input, textarea")).toBeNull()
  })

  it("names the .env variable each value comes from on self-host", async () => {
    await render(SELF_HOST, () => Response.json(SETTINGS))
    expect(container.textContent).toContain("DISABLE_SIGNUP")
    expect(container.textContent).toContain("SUPATYPE_MAILER_AUTOCONFIRM")
  })

  it("says Cloud manages them on Cloud, and names no .env", async () => {
    await render(CLOUD, () => Response.json(SETTINGS))
    expect(container.textContent).toContain("Managed by Supatype Cloud")
    expect(container.textContent).not.toContain("DISABLE_SIGNUP")
  })

  it("says why when the settings cannot be read", async () => {
    await render(SELF_HOST, () => Response.json({ error: "forbidden" }, { status: 403 }))
    expect(container.textContent).toContain("403")
    expect(container.textContent).not.toContain("Saved")
  })
})
