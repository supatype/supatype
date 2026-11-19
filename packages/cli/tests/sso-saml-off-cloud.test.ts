import { describe, expect, it } from "vitest"
import { samlOffWarning } from "../src/commands/sso.js"

/**
 * `supatype sso` warns when the config has SAML off. It said to restart the stack, which is no way
 * out on Supatype Cloud: there the config reaches the project on the next push, or Studio turns it on.
 */
describe("the SAML-off warning", () => {
  it("names push and Studio for a Cloud project", () => {
    const text = samlOffWarning(false, true) ?? ""
    expect(text).toContain("supatype push")
    expect(text).toContain("Studio")
    expect(text).not.toContain("restart the stack")
  })

  it("still names a restart elsewhere", () => {
    expect(samlOffWarning(false) ?? "").toContain("restart the stack")
  })
})
