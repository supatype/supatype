// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { createClient } from "@supatype/client"
import { StudioCore } from "../src/StudioCore.js"
import { proxyClientOptions } from "../src/components/StudioAccessGate.js"
import { studioAuthHeaders } from "../src/lib/studio-auth-headers.js"
import { ModelApiDocs } from "../src/views/ModelApiDocs.js"
import { ModelGraphQLDocs } from "../src/views/ModelGraphQLDocs.js"
import { InvokeTab } from "../src/views/EdgeFunctions.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { isArrayOf, isRecordOf, isShape, isString } from "../src/lib/json.js"
import { act, button, elementOf, findButton, isolateEachTest, mount, settle, testClient, testConfig, testField, testModel } from "./support.js"

/**
 * Owner decision 2026-10-21: choosing whose identity a request acts as only makes sense where
 * Studio sets the token on a request someone is building: a model's API "Try it", its GraphQL tab
 * and a function's Invoke. Content screens have no switch and no stored mode. Every request they
 * make asks for no mode, so the server's default applies: Studio for editors and viewers, full
 * access for admins and developers.
 */

const ACTING = "X-Supatype-Acting-Mode"
const BASE = "http://localhost:8000"
const PROXY = `${BASE}/studio/proxy`
const STORED_KEY = `supatype.studio.actingMode:${PROXY}`
const TOKEN = "studio-user-jwt"

const raw = readFileSync(join(process.cwd(), "../cli/src/role-matrix.json"), "utf8")
const parsed: unknown = JSON.parse(raw)
const isMatrix = isShape({ permissions: isRecordOf(isArrayOf(isString)) })
if (!isMatrix(parsed)) throw new Error("role-matrix.json is not the shared role document")
const matrix = parsed

function permissionsOf(role: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(matrix.permissions).map(([name, holders]) => [name, holders.includes(role)]))
}

/** Verify's answer for `role`, in the mode the server's default gives it. */
function verifyFor(role: string): Record<string, unknown> {
  const permissions = permissionsOf(role)
  const canElevate = permissions["elevatedSql"] === true
  return { role, mode: canElevate ? "elevated" : "studio", canElevate, permissions }
}

const MODEL = testModel({ name: "page", label: "Page", labelPlural: "Pages", tableName: "pages", fields: [testField({ name: "title" })] })
const CONFIG = testConfig({
  models: [MODEL],
  globals: [{ name: "site_settings", label: "Site Settings", tableName: "_global_site_settings", apiPath: "/rest/v1/_global_site_settings", fields: [] }],
})
const CLIENT = testClient({ url: PROXY, token: TOKEN })

/** Every request's headers, as sent. */
let sent: Array<{ url: string; headers: Headers }> = []

function serve(role: string): void {
  sent = []
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    sent.push({ url: input, headers: new Headers(init?.headers) })
    if (new URL(input).pathname.endsWith("/studio/auth/verify")) return Response.json(verifyFor(role))
    if (new URL(input).pathname.endsWith("/storage/v1/bucket")) return Response.json([{ id: "default", name: "default", public: false }])
    return Response.json([])
  })
}

const SWITCHES = ["Act as myself", "Edit as Studio", "Use elevated access"]
const ROLES = ["admin", "developer", "editor", "viewer"]
const CONTENT_SCREENS = ["/models/page", "/models/page/create", "/models/page/data", "/models/globals/site_settings", "/media-storage/default/files", "/media"]

isolateEachTest()

describe("content screens", () => {
  it.each(ROLES.flatMap((role) => CONTENT_SCREENS.map((path) => [role, path])))("offer %s no acting-mode switch on %s", async (role, path) => {
    serve(role)
    const { container } = await mount(
      <MemoryRouter initialEntries={[path]}>
        <StudioCore config={CONFIG} client={CLIENT} />
      </MemoryRouter>,
    )
    await settle(8)
    for (const label of SWITCHES) expect(findButton(container, label), label).toBeUndefined()
    expect(container.textContent).not.toContain("Acting as yourself")
    expect(container.textContent).not.toContain("Editing as Studio")
  })
})

describe("a mode left in storage by an earlier Studio", () => {
  it("is ignored by every request, and forgotten once Studio opens", async () => {
    window.localStorage.setItem(STORED_KEY, "self")
    expect(studioAuthHeaders(CLIENT)[ACTING]).toBeUndefined()
    const headers = proxyClientOptions(BASE, "anon", null).headers
    expect(typeof headers === "function" ? headers()[ACTING] : undefined).toBeUndefined()

    serve("editor")
    await mount(
      <MemoryRouter initialEntries={["/models/page"]}>
        <StudioCore config={CONFIG} client={CLIENT} />
      </MemoryRouter>,
    )
    await settle(4)
    expect(window.localStorage.getItem(STORED_KEY)).toBeNull()
    expect(sent.some((r) => r.headers.has(ACTING))).toBe(false)
  })

  it("does not send an editor's draft save as themselves: it asks for no mode, so it acts as Studio", async () => {
    window.localStorage.setItem(STORED_KEY, "self")
    serve("editor")
    const client = createClient({ ...proxyClientOptions(BASE, "anon", null), auth: { persistSession: false, detectSessionInUrl: false } })
    await client.from("pages").insert({ title: "Draft" })
    const save = sent.find((r) => r.url.includes("/rest/v1/pages"))
    expect(save).toBeDefined()
    expect(save?.headers.has(ACTING)).toBe(false)
  })
})

/** The panel's "Send as" choice. */
function sendAs(scope: ParentNode): HTMLSelectElement {
  return elementOf(scope, 'select[aria-label="Send as"]', HTMLSelectElement)
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(() => {
    select.value = value
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

async function panel(role: string, view: React.ReactElement): Promise<HTMLElement> {
  serve(role)
  const { container } = await mount(
    <AdminConfigContext.Provider value={CONFIG}>
      <AdminClientContext.Provider value={CLIENT}>{view}</AdminClientContext.Provider>
    </AdminConfigContext.Provider>,
  )
  await settle(4)
  return container
}

const options = (select: HTMLSelectElement): string[] => [...select.options].map((o) => o.textContent ?? "")

describe("the request builders keep a send-as choice", () => {
  it("a model's Try it sends as the signed-in user by default, with the app's rules, and as the service role when asked", async () => {
    const page = await panel("admin", <ModelApiDocs model={MODEL} />)
    await act(() => button(page, "Try It").click())
    expect(options(sendAs(page))).toEqual(["Me", "Anonymous", "Service role", "A token I paste"])
    await act(() => button(page, "Send GET Request").click())
    await settle()
    expect(sent.at(-1)?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`)
    expect(sent.at(-1)?.headers.get(ACTING)).toBe("self")
    await choose(sendAs(page), "service")
    await act(() => button(page, "Send GET Request").click())
    await settle()
    expect(sent.at(-1)?.headers.get(ACTING)).toBe("elevated")
  })

  it("offers an editor no service role", async () => {
    const page = await panel("editor", <ModelApiDocs model={MODEL} />)
    await act(() => button(page, "Try It").click())
    expect(options(sendAs(page))).toEqual(["Me", "Anonymous", "A token I paste"])
  })

  it("a model's GraphQL tab sends as the choice", async () => {
    const page = await panel("developer", <ModelGraphQLDocs model={MODEL} />)
    await choose(sendAs(page), "anon")
    await act(() => button(page, "Run").click())
    await settle()
    const query = sent.find((r) => r.url.endsWith("/graphql/v1"))
    expect(query?.headers.has("Authorization")).toBe(false)
  })

  it("a function's Invoke sends as the choice", async () => {
    const page = await panel("developer", <InvokeTab functionName="hello" clientUrl={BASE} />)
    expect(options(sendAs(page))).toContain("Service role")
    await choose(sendAs(page), "service")
    await act(() => button(page, "Invoke").click())
    await settle()
    expect(sent.at(-1)?.headers.get(ACTING)).toBe("elevated")
  })
})
