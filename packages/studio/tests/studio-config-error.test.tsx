import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { StudioConfigError, type StudioConfigErrorKind } from "../src/components/StudioConfigError.js"

/**
 * What Studio says when it cannot load its config.
 *
 * A refused session used to land in `unknown`, whose heading is "Could not load Studio config".
 * That reads as a fault in the deployment, so it sends the reader to their schema, their engine
 * and their containers — none of which are involved. A restarted server is enough to revoke a
 * refresh token, and then every `POST /studio-config` answers 401 while the API is working
 * perfectly.
 *
 * The distinction is worth a separate state because the action is completely different: sign in,
 * versus investigate.
 */

function render(kind: StudioConfigErrorKind, message?: string): string {
  return renderToStaticMarkup(
    React.createElement(StudioConfigError, {
      kind,
      baseUrl: "http://localhost:18476",
      onRetry: () => {},
      ...(message === undefined ? {} : { message }),
    }),
  )
}

describe("a refused session", () => {
  it("says the session expired rather than blaming the config", () => {
    const html = render("signed_out")
    expect(html).toContain("Your session has expired")
    expect(html).not.toContain("Could not load Studio config")
  })

  it("offers signing in rather than retrying", () => {
    expect(render("signed_out")).toContain("Sign in again")
  })

  it("says explicitly that the stack is not the problem", () => {
    // The whole point: stop the reader investigating their schema.
    expect(render("signed_out")).toContain("Nothing is wrong with your schema")
  })
})

describe("the states it must not be confused with", () => {
  it("keeps a genuinely unreachable API as its own message", () => {
    expect(render("network")).toContain("Cannot reach Studio config API")
  })

  it("keeps an un-pushed schema as its own message", () => {
    const html = render("not_pushed")
    expect(html).toContain("No schema has been pushed yet")
    expect(html).toContain("supatype push")
  })

  it("still has an unknown state for a status with no better answer", () => {
    const html = render("unknown", "HTTP_500")
    expect(html).toContain("Could not load Studio config")
    expect(html).toContain("HTTP_500")
    expect(html).toContain("Retry")
  })
})
