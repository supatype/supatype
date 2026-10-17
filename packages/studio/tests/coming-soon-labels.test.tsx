import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { SecondaryPanel } from "../src/components/SecondaryPanel.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { PlatformCtx, type PlatformContext } from "../src/hooks/usePlatform.js"
import { testClient } from "./support.js"

/**
 * Replication, Warehouse, Backups, SSO, AI Usage and the Realtime Inspector and its settings are
 * not built anywhere, Cloud included.
 *
 * Self-host used to mark them "Available on Supatype Cloud" with a Cloud badge, which told somebody
 * running their own stack that the hosted product had them and they were missing out. It did not.
 * They are labelled the way every other unbuilt entry is: listed, inert, and saying they are coming,
 * on self-host and on Cloud alike.
 */
const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined }
const CLOUD: PlatformContext = { platformUrl: "https://api.example.test", projectRef: "abc123" }

function panel(path: string, platform: PlatformContext): string {
  const client = testClient({ url: "http://localhost:8000" })
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [path] },
      React.createElement(
        PlatformCtx.Provider,
        { value: platform },
        React.createElement(
          AdminClientContext.Provider,
          { value: client },
          React.createElement(SecondaryPanel),
        ),
      ),
    ),
  )
}

/** The opening tag of the element whose first child holds `label`. */
function entryTag(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`)
  expect(at, `${label} is listed`).toBeGreaterThan(-1)
  const innerAt = html.lastIndexOf("<", at)
  const outerAt = html.lastIndexOf("<", innerAt - 1)
  return html.slice(outerAt, innerAt)
}

const ENTRIES: Array<{ path: string; label: string; note: string }> = [
  { path: "/database/overview", label: "Replication", note: "Read replicas are coming soon" },
  { path: "/database/overview", label: "Warehouse", note: "The analytical warehouse is coming soon" },
  { path: "/database/overview", label: "Backups", note: "Managed backups are coming soon" },
  { path: "/authentication/users", label: "SSO", note: "SSO is coming soon" },
  { path: "/ai/usage", label: "Usage", note: "AI usage tracking is coming soon" },
  { path: "/realtime", label: "Inspector", note: "The Realtime Inspector is coming soon" },
  { path: "/realtime", label: "Settings", note: "Realtime settings are coming soon" },
]

describe.each([
  ["self-host", SELF_HOST],
  ["cloud", CLOUD],
])("features not built anywhere, on %s", (_name, platform) => {
  it.each(ENTRIES)("lists $label as inert and coming soon", ({ path, label, note }) => {
    const tag = entryTag(panel(path, platform), label)
    expect(tag).toMatch(/^<span/)
    expect(tag).toContain('aria-disabled="true"')
    expect(tag).toContain(`title="${note}"`)
  })

  it.each(["/database/overview", "/authentication/users", "/ai/usage", "/realtime"])(
    "makes no Cloud claim in %s",
    (path) => {
      const html = panel(path, platform)
      expect(html).not.toContain("Supatype Cloud")
      expect(html).not.toMatch(/>Cloud</)
    },
  )
})
