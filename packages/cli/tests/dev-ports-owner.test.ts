import { describe, expect, it } from "vitest"
import { composeProjectOwnsPort } from "../src/dev-ports.js"

/**
 * The decision behind the port guard, without Docker.
 *
 * `supatype self-host compose up -d` followed by `supatype push` was impossible: the second
 * command saw its own gateway on the port and refused. The fix has to accept our own stack while
 * still refusing a stranger's, because proceeding against another project's gateway would push a
 * schema into the wrong database.
 */
describe("composeProjectOwnsPort", () => {
  it("accepts a port published by this project", () => {
    expect(composeProjectOwnsPort("supatype-validation\n", "supatype-validation")).toBe(true)
  })

  it("refuses a port published by a different project", () => {
    expect(composeProjectOwnsPort("someone-elses-stack\n", "supatype-validation")).toBe(false)
  })

  it("refuses when any publisher is a different project", () => {
    const output = "supatype-validation\nsomeone-elses-stack\n"
    expect(composeProjectOwnsPort(output, "supatype-validation")).toBe(false)
  })

  it("refuses when nothing reports a compose project", () => {
    // A container with no compose label: something is on the port, and it is not ours.
    expect(composeProjectOwnsPort("\n\n", "supatype-validation")).toBe(false)
    expect(composeProjectOwnsPort("", "supatype-validation")).toBe(false)
  })

  it("tolerates the whitespace docker pads its columns with", () => {
    expect(composeProjectOwnsPort("  supatype-validation  \n", "supatype-validation")).toBe(true)
  })

  it("does not match on a prefix", () => {
    // `supatype-validation-2` is a different project, and a substring check would accept it.
    expect(composeProjectOwnsPort("supatype-validation-2\n", "supatype-validation")).toBe(false)
  })
})
