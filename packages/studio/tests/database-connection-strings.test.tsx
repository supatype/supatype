// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Settings } from "../src/views/Settings.js"
import { ConnectModal } from "../src/components/ConnectModal.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { PlatformCtx, type PlatformContext } from "../src/hooks/usePlatform.js"
import { connectionString, type DatabaseConnection } from "../src/hooks/useDatabaseConnection.js"
import { testClient, testConfig } from "./support.js"

/**
 * Studio's database connection strings, which come from the server's account of where this
 * project's database is reached from the host.
 *
 * They used to be built from the API URL: Settings showed `postgres://postgres:[password]@<API
 * host>/postgres` (the gateway's port, a login and database a self-host stack does not have) and a
 * PgBouncer string for a deployment that ships no PgBouncer, and the Connect panel showed a
 * `[YOUR-HOST]:5432/postgres` template. These hold all of that to one source.
 */

const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined }
const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })
const DOCKER_DEV = { host: "127.0.0.1", port: 54329, database: "supatype", user: "supatype_admin" }
const DIRECT = "postgresql://supatype_admin:[YOUR-PASSWORD]@127.0.0.1:54329/supatype"

let container: HTMLDivElement
let root: Root
let requested: string[] = []

/** Answers the connection route with `connection`, and the credential routes as a dev stack does. */
function serve(connection: DatabaseConnection): void {
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url)
    if (url.endsWith("/admin/v1/database/connection")) return Response.json(connection)
    if (url.endsWith("/credentials/status")) {
      return Response.json({ mode: "local", password_status: "available", can_reveal: true, generation: 1 })
    }
    if (url.endsWith("/credentials/first-view")) return Response.json({ password: "p@ss/word" })
    return Response.json({})
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  requested = []
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

function button(label: string): HTMLButtonElement {
  // Exact first: the Connect panel's tab buttons also carry a subtitle, so fall back to a prefix.
  const buttons = Array.from(document.body.querySelectorAll("button"))
  const found = buttons.find((b) => b.textContent === label) ?? buttons.find((b) => b.textContent?.startsWith(label))
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

async function settingsTab(label: string): Promise<string> {
  await act(async () =>
    root.render(
      <PlatformCtx.Provider value={SELF_HOST}>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={CLIENT}>
            <Settings />
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </PlatformCtx.Provider>,
    ),
  )
  await act(async () => button(label).click())
  await settle()
  return container.textContent ?? ""
}

describe("Settings > Database", () => {
  it("shows the string the server declared, not one built from the API URL", async () => {
    serve({ direct: DOCKER_DEV, pooler: null })
    const text = await settingsTab("Database")
    expect(requested).toContain("http://localhost:8000/studio/proxy/admin/v1/database/connection")
    expect(text).toContain(DIRECT)
    expect(text).not.toContain("localhost:8000/postgres")
    expect(text).not.toContain("postgres://postgres:")
  })

  it("shows no pooler string when the deployment runs no pooler", async () => {
    serve({ direct: DOCKER_DEV, pooler: null })
    const text = await settingsTab("Database")
    expect(text).not.toMatch(/pooler/i)
    expect(text).not.toContain("pgbouncer")
  })

  it("shows the pooler string when there is one", async () => {
    serve({ direct: DOCKER_DEV, pooler: { ...DOCKER_DEV, port: 6432 } })
    const text = await settingsTab("Database")
    expect(text).toContain("Pooler connection string")
    expect(text).toContain("postgresql://supatype_admin:[YOUR-PASSWORD]@127.0.0.1:6432/supatype")
  })

  it("says the database is not published instead of printing a string", async () => {
    serve({ direct: null, pooler: null, unavailable: "This deployment does not publish its database to the host." })
    const text = await settingsTab("Database")
    expect(text).toContain("Not published")
    expect(text).toContain("does not publish its database")
    expect(text).not.toContain("postgresql://")
  })

  it("puts a revealed password into the string, encoded so it cannot move the host", async () => {
    serve({ direct: DOCKER_DEV, pooler: null })
    await settingsTab("Database")
    await act(async () => button("View Password").click())
    await settle()
    expect(container.textContent).toContain("postgresql://supatype_admin:p%40ss%2Fword@127.0.0.1:54329/supatype")
  })
})

describe("Settings > General", () => {
  it("no longer shows the API URL under the name Database URL", async () => {
    serve({ direct: DOCKER_DEV, pooler: null })
    const text = await settingsTab("General")
    expect(text).not.toContain("Database URL")
  })
})

describe("the Connect panel's Direct tab", () => {
  it("shows the same string and a psql command for it, with no placeholder host", async () => {
    serve({ direct: DOCKER_DEV, pooler: null })
    await act(async () =>
      root.render(
        <AdminClientContext.Provider value={CLIENT}>
          <ConnectModal open onClose={() => undefined} />
        </AdminClientContext.Provider>,
      ),
    )
    await act(async () => button("Direct").click())
    await settle()
    const text = document.body.textContent ?? ""
    expect(text).toContain(DIRECT)
    expect(text).toContain(`psql '${DIRECT}'`)
    expect(text).not.toContain("[YOUR-HOST]")
  })
})

describe("connectionString", () => {
  it("keeps the endpoint's parameters and brackets an IPv6 host", () => {
    expect(connectionString({ host: "::1", port: 5432, database: "app", user: "u", params: "sslmode=require" })).toBe(
      "postgresql://u:[YOUR-PASSWORD]@[::1]:5432/app?sslmode=require",
    )
  })

  it("encodes a quote, so the single-quoted psql command keeps the whole URL as one argument", () => {
    const url = connectionString({ host: "db", port: 5432, database: "it's", user: "o'neil" }, "a'b(c)!*")
    expect(url).toBe("postgresql://o%27neil:a%27b%28c%29%21%2A@db:5432/it%27s")
    expect(url).not.toContain("'")
  })
})
