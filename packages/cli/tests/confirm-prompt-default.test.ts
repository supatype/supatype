import { describe, expect, it } from "vitest"
import { confirmPromptHint } from "../src/ui/flows/prompt-fields.js"

/**
 * A yes/no prompt showed `Yes / No: y/n, ←/→, enter` whatever its default, so which answer enter
 * gave was told only by colour. The default is the capital letter, as in `Y/n`.
 */
describe("confirm prompt hint", () => {
  it("capitalises yes when enter means yes", () => {
    expect(confirmPromptHint(true)).toBe("Y/n, ←/→, enter for yes")
  })

  it("capitalises no when enter means no", () => {
    expect(confirmPromptHint(false)).toBe("y/N, ←/→, enter for no")
  })
})
