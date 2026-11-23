// @vitest-environment jsdom
import React from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { FunctionSecrets } from "../src/views/FunctionSecrets.js"
import { EdgeFunctions } from "../src/views/EdgeFunctions.js"
import { Settings } from "../src/views/Settings.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { PlatformCtx, type PlatformContext } from "../src/hooks/usePlatform.js"
import { act, button, elementOf, isolateEachTest, mount, settle, testClient, testConfig } from "./support.js"

/**
 * D-67: function secrets are one store with one component, shown in the Functions section, with
 * Settings pointing to it. D-64: it works on self-host (the gateway's /admin/v1/functions/env) and
 * on Cloud (the control plane's /projects/:ref/functions/env). D-65: a name is letters, digits and
 * underscore, not starting with a digit, refused inline before anything is sent.
 */

isolateEachTest()

interface Call { url: string; path: string; method: string; body: unknown; credentials: RequestCredentials | undefined }

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined }
const CLOUD: PlatformContext = { platformUrl: "/api/control-plane", projectRef: "abc123" }
const ENV_PATH = /\/admin\/v1\/functions(\/[^/]+)?\/env(\/.*)?$|\/projects\/abc123\/functions(\/[^/]+)?\/env(\/.*)?$/

/** Answers every secrets route from `names` and a function list with one function, and records the secrets requests. */
function serveEnv(names: string[], refuse?: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost")
    if (url.pathname.endsWith("/admin/v1/functions/list")) return Response.json({ data: [{ name: "hello", invocations24h: 0, avgDurationMs: 0 }] })
    if (!ENV_PATH.test(url.pathname)) return Response.json({})
    const call: Call = {
      url: url.pathname,
      path: url.pathname.replace(/^.*\/functions/, ""),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      credentials: init?.credentials,
    }
    calls.push(call)
    const refused = refuse?.(call)
    if (refused) return refused
    return call.method === "GET" ? Response.json({ data: names }) : Response.json({ data: { key: "k", message: "set" } })
  })
  return calls
}

function hosted(platform: PlatformContext, ui: React.ReactElement, at: string): React.ReactElement {
  return (
    <MemoryRouter initialEntries={[at]}>
      <PlatformCtx.Provider value={platform}>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={CLIENT}>
            <Routes>
              <Route path="/edge-functions/:functionSlug/:tab" element={ui} />
              <Route path="*" element={ui} />
            </Routes>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </PlatformCtx.Provider>
    </MemoryRouter>
  )
}

async function open(platform: PlatformContext, ui: React.ReactElement, at = "/"): Promise<HTMLElement> {
  const { container } = await mount(hosted(platform, ui, at))
  await settle()
  return container
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const keyInput = (container: HTMLElement): HTMLInputElement => elementOf(container, 'input[placeholder="KEY"]', HTMLInputElement)

describe("the function secrets component", () => {
  it("lists the secret names the server holds, never a value", async () => {
    const calls = serveEnv(["STRIPE_KEY", "RESEND_KEY"])
    const container = await open(SELF_HOST, <FunctionSecrets />)
    expect(calls[0]).toMatchObject({ path: "/env", method: "GET" })
    const text = container.textContent ?? ""
    expect(text).toContain("STRIPE_KEY")
    expect(text).toContain("RESEND_KEY")
    expect(text).toContain("ctx.env")
    expect(text).toContain("next call")
  })

  it("posts a new secret and says Saved", async () => {
    const calls = serveEnv([])
    const container = await open(SELF_HOST, <FunctionSecrets />)
    await typeInto(keyInput(container), "API_TOKEN")
    await typeInto(elementOf(container, 'input[placeholder="value"]', HTMLInputElement), "s3cret")
    await act(async () => { button(container, "Set secret").click() })
    await settle()
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/env", body: { key: "API_TOKEN", value: "s3cret" } })
    expect(container.querySelector('[data-ui="saved-notice"]')?.textContent).toBe("Saved")
    expect(elementOf(container, 'input[placeholder="value"]', HTMLInputElement).value).toBe("")
  })

  it("removes a secret after asking", async () => {
    const calls = serveEnv(["STRIPE_KEY"])
    const container = await open(SELF_HOST, <FunctionSecrets />)
    await act(async () => { button(container, "Remove").click() })
    await act(async () => { button(document.body, "Remove secret").click() })
    await settle()
    expect(calls.find((c) => c.method === "DELETE")).toMatchObject({ path: "/env/STRIPE_KEY" })
  })

  it("shows a refused set with its status and the server's words, and no Saved", async () => {
    serveEnv([], (c) => c.method === "POST" ? Response.json({ error: "key and value required" }, { status: 400, statusText: "Bad Request" }) : undefined)
    const container = await open(SELF_HOST, <FunctionSecrets />)
    await typeInto(keyInput(container), "X")
    await act(async () => { button(container, "Set secret").click() })
    await settle()
    const text = container.textContent ?? ""
    expect(text).toContain("400")
    expect(text).toContain("key and value required")
    expect(container.querySelector('[data-ui="saved-notice"]')).toBeNull()
  })

  it("shows a refused list instead of an empty page", async () => {
    serveEnv([], (c) => c.method === "GET" ? Response.json({ error: "no functions directory is configured" }, { status: 409, statusText: "Conflict" }) : undefined)
    const container = await open(SELF_HOST, <FunctionSecrets />)
    expect(container.textContent).toContain("409")
    expect(container.textContent).toContain("no functions directory is configured")
  })
})

describe("the secret name rule", () => {
  it.each(["1STRIPE", "has-dash", "has space", "dot.name"])("refuses %s inline and sends nothing", async (name) => {
    const calls = serveEnv([])
    const container = await open(SELF_HOST, <FunctionSecrets />)
    await typeInto(keyInput(container), name)
    await settle()
    expect(container.textContent).toContain("letters, digits and underscore")
    expect(keyInput(container).getAttribute("aria-invalid")).toBe("true")
    expect(button(container, "Set secret").disabled).toBe(true)
    await act(async () => { button(container, "Set secret").click() })
    await settle()
    expect(calls.filter((c) => c.method === "POST")).toEqual([])
  })

  it.each(["STRIPE_KEY", "_private", "key2"])("accepts %s", async (name) => {
    serveEnv([])
    const container = await open(SELF_HOST, <FunctionSecrets />)
    await typeInto(keyInput(container), name)
    await settle()
    expect(container.textContent).not.toContain("letters, digits and underscore")
    expect(button(container, "Set secret").disabled).toBe(false)
  })
})

describe("hosted by Cloud", () => {
  it("lists, sets and removes through the control plane's project route with the platform session", async () => {
    const calls = serveEnv(["STRIPE_KEY"])
    const container = await open(CLOUD, <FunctionSecrets />)
    expect(calls[0]).toMatchObject({ url: "/api/control-plane/projects/abc123/functions/env", method: "GET", credentials: "include" })
    await typeInto(keyInput(container), "API_TOKEN")
    await typeInto(elementOf(container, 'input[placeholder="value"]', HTMLInputElement), "s3cret")
    await act(async () => { button(container, "Set secret").click() })
    await settle()
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: "/api/control-plane/projects/abc123/functions/env", body: { key: "API_TOKEN", value: "s3cret" }, credentials: "include" })
    await act(async () => { button(container, "Remove").click() })
    await act(async () => { button(document.body, "Remove secret").click() })
    await settle()
    expect(calls.find((c) => c.method === "DELETE")).toMatchObject({ url: "/api/control-plane/projects/abc123/functions/env/STRIPE_KEY", credentials: "include" })
    expect(calls.every((c) => !c.url.includes("/admin/v1/"))).toBe(true)
  })

  it("shows the control plane's refusal, such as a failed apply", async () => {
    serveEnv([], (c) => c.method === "POST" ? Response.json({ error: "apply_failed", message: "could not apply to the workers" }, { status: 502, statusText: "Bad Gateway" }) : undefined)
    const container = await open(CLOUD, <FunctionSecrets />)
    await typeInto(keyInput(container), "X")
    await act(async () => { button(container, "Set secret").click() })
    await settle()
    expect(container.textContent).toContain("502")
    expect(container.querySelector('[data-ui="saved-notice"]')).toBeNull()
  })
})

describe("the Functions section's secrets", () => {
  it("shows the shared secrets with the one component, and no second copy of the form", async () => {
    const calls = serveEnv(["STRIPE_KEY"])
    const container = await open(SELF_HOST, <EdgeFunctions />, "/edge-functions/hello/env")
    expect(calls[0]).toMatchObject({ path: "/env", method: "GET" })
    expect(container.textContent).toContain("STRIPE_KEY")
    expect(container.querySelectorAll('input[placeholder="KEY"]')).toHaveLength(1)
    expect(container.querySelector('[aria-label="Function secrets"]')).not.toBeNull()
  })

  it("keeps one function's own secrets as a scope of the same component", async () => {
    const calls = serveEnv(["ONLY_HELLO"])
    const container = await open(SELF_HOST, <EdgeFunctions />, "/edge-functions/hello/env")
    await act(async () => { button(container, "Function (hello)").click() })
    await settle()
    expect(calls.at(-1)).toMatchObject({ path: "/hello/env", method: "GET" })
    expect(container.textContent).toContain("ONLY_HELLO")
    expect(container.querySelector('[aria-label="Secrets for hello"]')).not.toBeNull()
  })

  it("on Cloud shows the shared secrets first, and offers the function's own scope too", async () => {
    const calls = serveEnv(["STRIPE_KEY"])
    const container = await open(CLOUD, <EdgeFunctions />, "/edge-functions/hello/env")
    expect(calls[0]).toMatchObject({ url: "/api/control-plane/projects/abc123/functions/env", method: "GET" })
    expect(container.textContent).toContain("Function (hello)")
  })

  it("on Cloud keeps one function's own secrets at the control plane's per-function route, with the platform session", async () => {
    const calls = serveEnv(["ONLY_HELLO"])
    const container = await open(CLOUD, <EdgeFunctions />, "/edge-functions/hello/env")
    await act(async () => { button(container, "Function (hello)").click() })
    await settle()
    expect(calls.at(-1)).toMatchObject({ url: "/api/control-plane/projects/abc123/functions/hello/env", method: "GET", credentials: "include" })
    expect(container.textContent).toContain("ONLY_HELLO")
    expect(container.querySelector('[aria-label="Secrets for hello"]')).not.toBeNull()
    await typeInto(keyInput(container), "API_TOKEN")
    await typeInto(elementOf(container, 'input[placeholder="value"]', HTMLInputElement), "s3cret")
    await act(async () => { button(container, "Set secret").click() })
    await settle()
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: "/api/control-plane/projects/abc123/functions/hello/env", body: { key: "API_TOKEN", value: "s3cret" }, credentials: "include" })
    await act(async () => { button(container, "Remove").click() })
    await act(async () => { button(document.body, "Remove secret").click() })
    await settle()
    expect(calls.find((c) => c.method === "DELETE")).toMatchObject({ url: "/api/control-plane/projects/abc123/functions/hello/env/ONLY_HELLO", credentials: "include" })
    expect(calls.every((c) => !c.url.includes("/admin/v1/"))).toBe(true)
  })

  it("on Cloud never answers a function's scope from the shared store", async () => {
    const calls = serveEnv(["SHARED_ONLY"])
    const container = await open(CLOUD, <FunctionSecrets scope={{ kind: "function", name: "hello" }} />)
    expect(calls.map((c) => c.url)).toEqual(["/api/control-plane/projects/abc123/functions/hello/env"])
    expect(container.textContent).not.toContain("Cloud keeps secrets for the whole project")
  })

  it("encodes a function name that is not URL-safe on Cloud, as on self-host", async () => {
    const calls = serveEnv([])
    await open(CLOUD, <FunctionSecrets scope={{ kind: "function", name: "a/b" }} />)
    expect(calls[0]?.url).toBe("/api/control-plane/projects/abc123/functions/a%2Fb/env")
  })
})

describe("Settings > Environment", () => {
  it("is a note that links to the Functions section's secrets, and holds no form", async () => {
    const calls = serveEnv([])
    const container = await open(SELF_HOST, <Settings />)
    await act(async () => { button(container, "Environment").click() })
    await settle()
    expect(calls).toEqual([])
    expect(container.querySelector('input[placeholder="KEY"]')).toBeNull()
    const link = container.querySelector<HTMLAnchorElement>('a[data-ui="text-link"]')
    expect(link?.getAttribute("href")).toBe("/edge-functions?tab=env")
    expect(container.textContent).toContain("Functions")
  })
})

describe("the secret name message", () => {
  it("is the one @supatype/types gives, naming the refused name", async () => {
    serveEnv([])
    const container = await open(SELF_HOST, <FunctionSecrets />)
    await typeInto(keyInput(container), "1STRIPE")
    await settle()
    expect(container.textContent).toContain('"1STRIPE" is not a valid secret name: use letters, digits and underscore, and do not start with a digit.')
  })
})
