// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { SupatypeClient } from "@supatype/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { PlatformCtx, type PlatformContext } from "../src/hooks/usePlatform.js"
import { ProvidersView } from "../src/views/auth/ProvidersView.js"

/**
 * The Providers page showed a hard-coded list with every OAuth provider disabled, and Enable and
 * Configure buttons that changed only the page's own state. It disagreed with the Configuration
 * page and with the auth server, which reported GitHub and Keycloak enabled. It now reads the same
 * `GET /auth/v1/settings` the Configuration page reads, lists every provider the server reports,
 * and says where each one is set instead of offering edits no host accepts from Studio.
 */

const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined }
const CLOUD: PlatformContext = { platformUrl: "https://api.example.test/api/v1", projectRef: "abc123" }
const CLIENT = {
  url: "http://localhost:8000/studio/proxy",
  auth: { currentAccessToken: "token" },
} as unknown as SupatypeClient

const SETTINGS = {
  external: {
    anonymous_users: false,
    email: true,
    phone: false,
    github: true,
    google: false,
    keycloak: true,
    linkedin_oidc: false,
    zoom: false,
  },
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
          <ProvidersView />
        </AdminClientContext.Provider>
      </PlatformCtx.Provider>,
    ),
  )
  for (let i = 0; i < 5; i++) await act(async () => {})
}

/** The status badge in the row for one provider. */
function statusOf(provider: string): string | undefined {
  const rows = Array.from(container.querySelectorAll("tr"))
  const row = rows.find((r) => r.querySelector("td")?.textContent === provider)
  return row?.querySelectorAll("td")[1]?.textContent ?? undefined
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.unstubAllGlobals()
})

describe("the auth Providers page", () => {
  it("reads the auth server's settings, the same source as the Configuration page", async () => {
    await render(SELF_HOST, () => Response.json(SETTINGS))
    expect(requested).toEqual(["http://localhost:8000/studio/proxy/auth/v1/settings"])
  })

  it("shows the providers the server reports enabled as enabled, Keycloak included", async () => {
    await render(SELF_HOST, () => Response.json(SETTINGS))
    expect(statusOf("github")).toBe("Enabled")
    expect(statusOf("keycloak")).toBe("Enabled")
    expect(statusOf("google")).toBe("Disabled")
  })

  it("lists every OAuth provider the server reports, and leaves email, phone and anonymous to Configuration", async () => {
    await render(SELF_HOST, () => Response.json(SETTINGS))
    expect(statusOf("linkedin_oidc")).toBe("Disabled")
    expect(statusOf("zoom")).toBe("Disabled")
    expect(statusOf("email")).toBeUndefined()
    expect(statusOf("anonymous_users")).toBeUndefined()
  })

  it("offers no Enable or Configure, and names where each provider is set on self-host", async () => {
    await render(SELF_HOST, () => Response.json(SETTINGS))
    expect(container.querySelector("button, input, textarea")).toBeNull()
    expect(container.textContent).toContain("auth.providers.keycloak")
    expect(container.textContent).toContain("SUPATYPE_EXTERNAL_KEYCLOAK_ENABLED")
  })

  it("says Cloud manages them on Cloud", async () => {
    await render(CLOUD, () => Response.json(SETTINGS))
    expect(container.textContent).toContain("Managed by Supatype Cloud")
    expect(container.textContent).not.toContain("SUPATYPE_EXTERNAL_")
  })

  it("says why when the settings cannot be read", async () => {
    await render(SELF_HOST, () => Response.json({ error: "forbidden" }, { status: 403 }))
    expect(container.textContent).toContain("403")
    expect(statusOf("github")).toBeUndefined()
  })
})
