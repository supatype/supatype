/**
 * Rendering a form inside a provider over the real client, and driving it as a user would.
 */

import React from "react"
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { vi, type Mock } from "vitest"
import { createClient, type Session } from "@supatype/client"
import { SupatypeProvider } from "@supatype/react"
import { fire, stringProp } from "./props.js"

export const API = "http://localhost:9999"

/** Render `ui` inside a `SupatypeProvider` holding a real client, signed in when given a session. */
export function render(ui: React.ReactElement, session?: Session): ReactTestRenderer {
  const client = createClient({ url: API, anonKey: "anon", ...(session !== undefined && { initialSession: session }) })
  let renderer: ReactTestRenderer | null = null
  act(() => { renderer = create(<SupatypeProvider client={client}>{ui}</SupatypeProvider>) })
  return renderer!
}

/** Type `value` into the input with this id. */
export function type(renderer: ReactTestRenderer, id: string, value: string): void {
  const input = renderer.root.find((node) => node.type === "input" && node.props["id"] === id)
  act(() => { fire(input, "onChange", { target: { value } }) })
}

/** Submit the form and wait for its request to settle. */
export async function submit(renderer: ReactTestRenderer): Promise<void> {
  const form = renderer.root.findByType("form")
  await act(async () => { await fire(form, "onSubmit", { preventDefault: () => undefined }) })
}

/** The text inside a node, its children's included. */
export function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("")
}

export interface SentRequest {
  url: URL
  method: string
  body: unknown
  authorization: string | null
}

/** Stub `fetch` with one answer and record every request the client sends. */
export function stubFetch(status: number, body: unknown): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    sent.push({
      url: new URL(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null,
      authorization: headers.get("Authorization"),
    })
    return new Response(JSON.stringify(body), { status })
  }))
  return sent
}

/** A browser at `href` whose navigations are recorded, with a localStorage holding `stored`. */
export function stubBrowser(href = "https://app.example/login", stored: Record<string, string> = {}): { assign: Mock<(url: string) => void> } {
  const store = new Map(Object.entries(stored))
  const assign = vi.fn<(url: string) => void>()
  vi.stubGlobal("window", {
    location: { href, protocol: "https:", assign },
    history: { state: null, replaceState: vi.fn() },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
  })
  return { assign }
}

/** The class on each element of this type, in order. */
export function classesOf(root: ReactTestInstance, type: keyof React.JSX.IntrinsicElements): Array<string | undefined> {
  return root.findAllByType(type).map((node) => stringProp(node, "className"))
}
