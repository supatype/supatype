import { describe, expect, it } from "vitest"
import { dockerApplyMessage } from "../src/commands/push.js"

/**
 * Fresh-user test, cosmetic: `push --yes` printed "Applying schema via Docker Compose..." twice.
 * The second is the retry after the engine refused a destructive change and `--yes` allowed it,
 * so it says so rather than repeating the first line word for word.
 */
describe("docker push apply message", () => {
  it("says the second attempt applies what --yes allowed", () => {
    expect(dockerApplyMessage(false, "compose")).toBe("Applying schema via Docker Compose")
    expect(dockerApplyMessage(true, "compose")).not.toBe(dockerApplyMessage(false, "compose"))
    expect(dockerApplyMessage(true, "compose")).toMatch(/destructive|rewrite/i)
  })

  // With `overrides.engine` the push never runs through Docker Compose: the host binary applies it.
  it("names the host engine when overrides.engine applies the push", () => {
    expect(dockerApplyMessage(false, "host")).toBe("Applying schema via local engine (overrides.engine)")
    expect(dockerApplyMessage(true, "host")).toMatch(/^Applying schema via local engine \(overrides\.engine\), .*destructive/)
    expect(dockerApplyMessage(true, "host")).not.toMatch(/compose/i)
  })
})
