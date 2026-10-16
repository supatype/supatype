/**
 * Rendering a form inside a provider over the real client, and driving it as a user would.
 */

import React from "react"
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { createClient, type Session } from "@supatype/client"
import { SupatypeProvider } from "@supatype/react"

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
  act(() => { (input.props["onChange"] as (e: { target: { value: string } }) => void)({ target: { value } }) })
}

/** Submit the form and wait for its request to settle. */
export async function submit(renderer: ReactTestRenderer): Promise<void> {
  const form = renderer.root.findByType("form")
  await act(async () => { (form.props["onSubmit"] as (e: { preventDefault(): void }) => void)({ preventDefault: () => undefined }) })
}

/** The text inside a node, its children's included. */
export function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("")
}

/** The class on each element of this type, in order. */
export function classesOf(root: ReactTestInstance, type: keyof React.JSX.IntrinsicElements): Array<string | undefined> {
  return root.findAllByType(type).map((node) => node.props["className"] as string | undefined)
}
