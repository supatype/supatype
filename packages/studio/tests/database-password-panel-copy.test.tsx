import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { DatabasePasswordPanel } from "../src/components/database/DatabasePasswordPanel.js"

/**
 * The reset hint was written with a literal escape sequence in JSX text, which React does not
 * interpret, so the page showed the six characters backslash, u, 2, 0, 1, 4 in the middle of a sentence.
 */
describe("DatabasePasswordPanel copy", () => {
  const html = renderToStaticMarkup(
    React.createElement(DatabasePasswordPanel, {
      onResetPassword: () => Promise.resolve("new-password"),
      onPasswordChanged: () => undefined,
    }),
  )

  it("renders no backslash escape in its text", () => {
    expect(html).not.toContain("\\")
  })

  it("says the new password is shown once, as its own sentence", () => {
    expect(html).toContain("reset it below. The new password is shown once.")
  })
})
