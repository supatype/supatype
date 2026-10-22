import { describe, expect, it } from "vitest"
import { textPromptAnswer, textPromptStart } from "../src/ui/flows/prompt-fields.js"

/**
 * Fresh-user test C10: init's gateway port prompt put the default in the input as editable text,
 * so typing a port appended to it (`18478` + `8700` = `184788700`) and the answer was refused.
 * A default is shown as the placeholder and used when the answer is left empty; typing replaces it.
 */
const spec = { kind: "text" as const, message: "Local API gateway port (Kong)", defaultValue: "18478", placeholder: "18473" }

describe("text prompt default", () => {
  it("starts empty, showing the default as the placeholder", () => {
    expect(textPromptStart(spec)).toEqual({ value: "", placeholder: "18478" })
  })

  it("uses the default when the answer is left empty", () => {
    expect(textPromptAnswer("", spec)).toBe("18478")
    expect(textPromptAnswer("   ", spec)).toBe("18478")
  })

  it("uses what was typed in place of the default", () => {
    expect(textPromptAnswer("18700", spec)).toBe("18700")
  })

  it("keeps the placeholder when there is no default", () => {
    expect(textPromptStart({ kind: "text", message: "Admin email", placeholder: "you@example.com" })).toEqual({
      value: "",
      placeholder: "you@example.com",
    })
    expect(textPromptAnswer("", { kind: "text", message: "Admin email" })).toBe("")
  })
})
