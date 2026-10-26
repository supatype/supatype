import { describe, expect, it } from "vitest"
import { dockerApplyMessage } from "../src/commands/push.js"

/**
 * Fresh-user test, cosmetic: `push --yes` printed "Applying schema via Docker Compose..." twice.
 * The second is the retry after the engine refused a destructive change and `--yes` allowed it,
 * so it says so rather than repeating the first line word for word.
 */
describe("docker push apply message", () => {
  it("says the second attempt applies what --yes allowed", () => {
    expect(dockerApplyMessage(false)).toBe("Applying schema via Docker Compose")
    expect(dockerApplyMessage(true)).not.toBe(dockerApplyMessage(false))
    expect(dockerApplyMessage(true)).toMatch(/destructive|rewrite/i)
  })
})
