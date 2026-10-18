// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { LivePreviewPane } from "../src/components/LivePreviewPane.js"
import { testModel } from "./support.js"

/**
 * The live preview pane posts unsaved form state only to the origin of the page it framed.
 *
 * It used to post with a target origin of `"*"`, so whatever document the iframe held when the
 * message went out received the editor's unsaved draft: a preview page that redirected elsewhere,
 * or one navigated away from by a script on it. The message now names the preview URL's origin, and
 * the browser drops it when the frame holds anything else.
 */

let root: Root | null = null

function renderPane(previewUrl: string): MockInstance<Window["postMessage"]> {
  const post = vi.spyOn(window, "postMessage").mockImplementation(() => undefined)
  // The pane's iframe, standing in for a loaded frame: jsdom fetches nothing, so its own window
  // would not be the one the test can watch.
  vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(window)
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <LivePreviewPane previewUrl={previewUrl} values={{ title: "Draft" }} model={testModel({ name: "Post" })} awaitingFirstSave={false} />,
    )
  })
  return post
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("LivePreviewPane target origin", () => {
  it("posts to the preview page's origin, not to any origin", () => {
    const post = renderPane("https://app.example.com/blog/hello")
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]?.[1]).toBe("https://app.example.com")
  })

  it("resolves a path against Studio's own origin", () => {
    const post = renderPane("/blog/hello")
    expect(post.mock.calls[0]?.[1]).toBe(window.location.origin)
  })
})
