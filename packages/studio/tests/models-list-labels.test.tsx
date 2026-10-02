import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import type { SupatypeClient } from "@supatype/client"
import { SecondaryPanel } from "../src/components/SecondaryPanel.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { normalizeAdminConfig } from "../src/lib/normalize-admin-config.js"

/**
 * A long model label in the Models list (issue #95).
 *
 * A `<button>` centres its text by default, so a label that wrapped onto a second line sat indented
 * under the entry above and read as a nested sub-model. Each entry is one left-aligned line now, the
 * overflow clipped, and the full label kept on hover.
 */
const LONG = "ChildEducationExperiences"
const LABEL = "Child Education Experiences"

function modelsList(): string {
  const config = normalizeAdminConfig({
    models: [{ name: LONG, tableName: "child_education_experiences", fields: [] }],
  })
  const client = { url: "http://localhost:8000" } as unknown as SupatypeClient
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/models"] },
      React.createElement(
        AdminClientContext.Provider,
        { value: client },
        React.createElement(
          AdminConfigContext.Provider,
          { value: config },
          React.createElement(SecondaryPanel),
        ),
      ),
    ),
  )
}

/** The opening tag of the element that directly holds `text`, and of its parent. */
function enclosingTags(html: string, text: string): { inner: string; outer: string } {
  const at = html.indexOf(`>${text}<`)
  expect(at).toBeGreaterThan(-1)
  const innerAt = html.lastIndexOf("<", at)
  const outerAt = html.lastIndexOf("<", innerAt - 1)
  return { inner: html.slice(innerAt, at + 1), outer: html.slice(outerAt, innerAt) }
}

describe("Models list entries", () => {
  const { inner, outer } = enclosingTags(modelsList(), LABEL)

  it("renders the label in one left-aligned, truncated line inside the button", () => {
    expect(outer).toMatch(/^<button[^>]*\btext-left\b/)
    expect(inner).toMatch(/\btruncate\b/)
    expect(inner).toMatch(/\bmin-w-0\b/)
  })

  it("keeps the full label on hover, since the visible one may be clipped", () => {
    expect(inner).toContain(`title="${LABEL}"`)
  })
})
