// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RestCacheBrowser } from "../src/views/RestCacheBrowser.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import type { AdminConfig } from "../src/config.js"
import type { SupatypeClient } from "@supatype/client"

/**
 * The first paint of a view that contains a `SlidePanel`.
 *
 * Every other view gets a cheap "does it render at all" test through
 * `renderToStaticMarkup` — a typecheck says a component is well typed, it does not say it runs.
 * Views with a SlidePanel could not have one: `SlidePanel` calls `createPortal` in its render
 * body, and **react-dom/server refuses portals outright**, so the static renderer was never the
 * missing piece. What was missing is a DOM to mount into.
 *
 * So this mounts for real, with jsdom and `react-dom/client`. That is stricter than the static
 * tests rather than a workaround for them: effects run, so a hook reading a context that is not
 * there, or an unguarded `document` access in an effect, fails here and passes there.
 *
 * Twelve files import SlidePanel — every `database/` view, AuthManagement, LogsViewer,
 * ConnectModal. This covers one of them and unblocks the rest.
 */

const client = { url: "http://localhost:8000/studio/proxy" } as unknown as SupatypeClient

const config = {
  projectName: "acme",
  models: [],
  tier: "pro",
} as unknown as AdminConfig

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // React refuses to run act() outside an environment that declares itself one.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Effects run here, so the list fetch fires. Stubbed with an empty page rather than left to
  // hit the network: an unstubbed fetch fails asynchronously, after the assertion has passed.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ entries: [], cursor: "0" }), { status: 200 })),
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(ui: React.ReactElement): void {
  act(() => {
    root.render(
      <AdminClientContext.Provider value={client}>
        <AdminConfigContext.Provider value={config}>{ui}</AdminConfigContext.Provider>
      </AdminClientContext.Provider>,
    )
  })
}

describe("a view that portals", () => {
  it("mounts, and renders its heading", () => {
    render(<RestCacheBrowser />)
    expect(container.textContent).toContain("REST Cache")
  })

  it("puts the slide panel in document.body, not in the view's own subtree", () => {
    // The thing that made this view untestable is also the thing worth asserting: the panel is a
    // portal, so it is absent from the container and present in the document.
    render(<RestCacheBrowser />)
    expect(container.querySelector(".fixed.inset-0")).toBeNull()
    expect(document.body.querySelector(".fixed.inset-0")).not.toBeNull()
  })

  it("renders the empty state rather than a permanent skeleton", async () => {
    // The first paint is a skeleton; once the stubbed fetch resolves it has to become something.
    // A view that never leaves its loading state looks fine in a static render and is broken on
    // screen, so this waits for the effect's promise to settle and asserts what replaced it.
    //
    // `await`, not `.then()`: the first version of this returned the chained promise, which React
    // flushed internally — the assertion failed against an unmounted container, after the test had
    // already been recorded as passing. Vitest reported it as an unhandled error beside a green
    // test, which is the shape of a false positive worth remembering.
    render(<RestCacheBrowser />)
    await act(async () => {})

    expect(container.textContent).toContain("No cache entries")
  })
})
