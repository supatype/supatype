/**
 * `useLivePreview` applies a preview message only when Studio sent it.
 *
 * The hook used to apply any `supatype:live-preview` message posted to the window, whoever posted
 * it. Any page that could frame the app, or any window it opened, could repaint it with content of
 * its choosing. A message now has to come from the parent window and from Studio's origin: the
 * origin of the provider's client URL (Studio is served at `/studio/` on it) unless `studioOrigin`
 * names another.
 */

import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createClient } from "@supatype/client"
import { SupatypeProvider } from "../src/context.js"
import { useLivePreview, type UseLivePreviewOptions } from "../src/useLivePreview.js"

interface Post {
  title: string
}

const API_URL = "http://localhost:18473"
const studioWindow = new EventTarget()

let renderer: ReactTestRenderer | null = null
let latest: { data: Post; isPreview: boolean } | null = null

function Probe({ opts }: { opts: UseLivePreviewOptions<Post> }): null {
  latest = useLivePreview(opts)
  return null
}

function mount(opts: UseLivePreviewOptions<Post>, withProvider = true): void {
  const probe = <Probe opts={opts} />
  const client = createClient({ url: API_URL, anonKey: "anon" })
  act(() => {
    renderer = create(withProvider ? <SupatypeProvider client={client}>{probe}</SupatypeProvider> : probe)
  })
}

/** A `message` event as a browser delivers one. Node's `MessageEvent` refuses a window as `source`. */
function post(origin: string, source: EventTarget = studioWindow): void {
  const event = Object.assign(new Event("message"), {
    origin,
    source,
    data: { type: "supatype:live-preview", model: "post", data: { title: "Edited" } },
  })
  act(() => {
    window.dispatchEvent(event)
  })
}

const initialData: Post = { title: "Saved" }

beforeEach(() => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { parent: studioWindow }))
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  latest = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("useLivePreview origin check", () => {
  it("applies a message from the client URL's origin", () => {
    mount({ initialData, model: "post" })
    post(API_URL)
    expect(latest).toEqual({ data: { title: "Edited" }, isPreview: true })
  })

  it("ignores a message from a foreign origin", () => {
    mount({ initialData, model: "post" })
    post("https://attacker.example")
    expect(latest).toEqual({ data: initialData, isPreview: false })
  })

  it("ignores a message from the right origin sent by a window that is not the parent", () => {
    mount({ initialData, model: "post" })
    post(API_URL, new EventTarget())
    expect(latest).toEqual({ data: initialData, isPreview: false })
  })

  it("trusts only the origins `studioOrigin` names when it is given", () => {
    mount({ initialData, model: "post", studioOrigin: ["https://studio.example.com/studio/"] })
    post(API_URL)
    expect(latest?.isPreview).toBe(false)
    post("https://studio.example.com")
    expect(latest).toEqual({ data: { title: "Edited" }, isPreview: true })
  })

  it("ignores every message with no provider and no `studioOrigin`", () => {
    mount({ initialData, model: "post" }, false)
    post(API_URL)
    expect(latest).toEqual({ data: initialData, isPreview: false })
  })

  it("says once which origin it refused, so a misconfigured Studio origin is findable", () => {
    mount({ initialData, model: "post" })
    post("https://attacker.example")
    post("https://attacker.example")
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain("https://attacker.example")
  })
})
